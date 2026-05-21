import { env } from '../config/index.js';
import type { CallerConfig } from '../config/index.js';
import { logger } from '../utils/index.js';
import os from 'os';
import crypto from 'crypto';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const sip = require('@vexyl.ai/sip');
const digest = require('@vexyl.ai/sip/digest');

export interface SipRingResult {
  success: boolean;
  error?: string;
}

export interface SipMessageResult {
  success: boolean;
  error?: string;
}

function getLocalIp(): string {
  const nets = os.networkInterfaces();
  for (const ifaces of Object.values(nets)) {
    for (const iface of ifaces ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

function makeSdp(ip: string): string {
  const id = Date.now();
  return (
    [
      'v=0',
      `o=- ${id} ${id} IN IP4 ${ip}`,
      's=Alert',
      `c=IN IP4 ${ip}`,
      't=0 0',
      'm=audio 20000 RTP/AVP 0 8',
      'a=rtpmap:0 PCMU/8000',
      'a=rtpmap:8 PCMA/8000',
      'a=sendonly',
    ].join('\r\n') + '\r\n'
  );
}

// Persistent stack — started once, shared across all callers
let stackStarted = false;
let localIp = '127.0.0.1';
let stackPort = 5060;
let activeCallFinish: ((success: boolean, error?: string) => void) | null = null;
let sipActive = false;

function ensureStack() {
  if (stackStarted) return;
  localIp = getLocalIp();
  stackPort = 5060 + Math.floor(Math.random() * 4000);

  sip.start(
    { port: stackPort, address: localIp, hostname: localIp },
    (req: Record<string, unknown>) => {
      if (req.method === 'BYE') {
        sip.send(sip.makeResponse(req, 200, 'OK'));
        if (activeCallFinish) {
          activeCallFinish(true);
          activeCallFinish = null;
        }
      } else {
        sip.send(sip.makeResponse(req, 200, 'OK'));
      }
    },
  );

  stackStarted = true;
}

export async function sendSipMessage(text: string, caller: CallerConfig): Promise<SipMessageResult> {
  ensureStack();

  const targetUri = `sip:${env.SIP_TARGET_USER}@${env.SIP_TARGET_DOMAIN}`;
  const fromUri = `sip:${caller.sip_username}@${caller.sip_domain}`;

  const buildMessage = (authHeaders?: Record<string, unknown>) => ({
    method: 'MESSAGE',
    uri: targetUri,
    headers: {
      to: { uri: targetUri },
      from: { uri: fromUri, params: { tag: crypto.randomBytes(4).toString('hex') } },
      'call-id': `${crypto.randomUUID()}@${localIp}`,
      cseq: { method: 'MESSAGE', seq: 1 },
      'max-forwards': 70,
      'content-type': 'text/plain;charset=UTF-8',
      'content-length': Buffer.byteLength(text),
      ...authHeaders,
    },
    content: text,
  });

  logger.info({ target: targetUri, caller: caller.id }, 'SIP message sending');

  return new Promise((resolve) => {
    const rq = buildMessage();
    sip.send(rq, (rs: Record<string, unknown>) => {
      const status = rs.status as number;
      if (status < 200) return;

      if (status === 401 || status === 407) {
        const authCtx: Record<string, unknown> = {};
        const authRq = buildMessage();
        digest.signRequest(authCtx, authRq, rs, {
          user: caller.sip_username,
          password: caller.sip_password,
        });
        sip.send(authRq, (rs2: Record<string, unknown>) => {
          const s2 = rs2.status as number;
          if (s2 < 200) return;
          if (s2 >= 200 && s2 < 300) {
            resolve({ success: true });
          } else {
            logger.warn({ status: s2, reason: rs2.reason }, 'SIP message delivery failed after auth');
            resolve({ success: false, error: `SIP ${s2}: ${rs2.reason}` });
          }
        });
        return;
      }

      if (status >= 200 && status < 300) {
        resolve({ success: true });
      } else {
        logger.warn({ status, reason: rs.reason }, 'SIP message delivery uncertain');
        resolve({ success: false, error: `SIP ${status}: ${rs.reason}` });
      }
    });
  });
}

export async function ringViaSip(caller: CallerConfig): Promise<SipRingResult> {
  if (sipActive) {
    return { success: false, error: 'SIP call already in progress' };
  }

  ensureStack();
  sipActive = true;

  const targetUri = `sip:${env.SIP_TARGET_USER}@${env.SIP_TARGET_DOMAIN}`;
  const fromUri = `sip:${caller.sip_username}@${caller.sip_domain}`;
  const callId = `${crypto.randomUUID()}@${localIp}`;
  const fromTag = crypto.randomBytes(4).toString('hex');
  const ringDuration = env.SIP_RING_DURATION_MS;

  let cseq = 1;
  let done = false;
  let callAnswered = false;
  let ringTimer: NodeJS.Timeout | undefined;
  let toHeader: unknown = null;
  let fromHeader: unknown = null;
  let authCtx: Record<string, unknown> = {};

  return new Promise((resolve) => {
    const finish = (success: boolean, error?: string) => {
      if (done) return;
      done = true;
      clearTimeout(ringTimer);
      activeCallFinish = null;
      sipActive = false;
      resolve({ success, error });
    };

    activeCallFinish = finish;

    const buildInvite = () => {
      const sdp = makeSdp(localIp);
      return {
        method: 'INVITE',
        uri: targetUri,
        headers: {
          to: { uri: targetUri },
          from: { uri: fromUri, params: { tag: fromTag } },
          'call-id': callId,
          cseq: { method: 'INVITE', seq: cseq++ },
          contact: [{ uri: `sip:${caller.sip_username}@${localIp}` }],
          'max-forwards': 70,
          'content-type': 'application/sdp',
          'content-length': Buffer.byteLength(sdp),
        },
        content: sdp,
      };
    };

    const sendCancel = (rq: Record<string, unknown>) => {
      const headers = rq.headers as Record<string, unknown>;
      const cseqObj = headers.cseq as { seq: number };
      sip.send(
        {
          method: 'CANCEL',
          uri: targetUri,
          headers: {
            to: headers.to,
            from: headers.from,
            'call-id': callId,
            cseq: { method: 'CANCEL', seq: cseqObj.seq },
            'max-forwards': 70,
            'content-length': 0,
          },
        },
        () => finish(true),
      );
    };

    const sendBye = () => {
      sip.send(
        {
          method: 'BYE',
          uri: targetUri,
          headers: {
            to: toHeader,
            from: fromHeader,
            'call-id': callId,
            cseq: { method: 'BYE', seq: cseq++ },
            'max-forwards': 70,
            'content-length': 0,
          },
        },
        () => finish(true),
      );
    };

    const handleResponse = (rq: Record<string, unknown>, rs: Record<string, unknown>) => {
      if (done) return;
      const status = rs.status as number;
      const rsHeaders = rs.headers as Record<string, unknown>;
      const rqHeaders = rq.headers as Record<string, unknown>;

      if (status === 100 || status === 110) return;

      if (status === 401 || status === 407) {
        const authRq = buildInvite();
        digest.signRequest(authCtx, authRq, rs, {
          user: caller.sip_username,
          password: caller.sip_password,
        });
        logger.info({ caller: caller.id }, 'SIP auth challenge — retrying with credentials');
        sip.send(authRq, (rs2: Record<string, unknown>) => handleResponse(authRq, rs2));
        return;
      }

      if (status === 180 || status === 183) {
        logger.info({ target: targetUri, caller: caller.id }, 'SIP: phone is ringing');
        toHeader = rsHeaders.to;
        fromHeader = rqHeaders.from;
        ringTimer = setTimeout(() => {
          if (!callAnswered) sendCancel(rq);
          else sendBye();
        }, ringDuration);
      } else if (status === 200) {
        callAnswered = true;
        toHeader = rsHeaders.to;
        fromHeader = rqHeaders.from;
        const cseqObj = rqHeaders.cseq as { seq: number };
        sip.send({
          method: 'ACK',
          uri: targetUri,
          headers: {
            to: rsHeaders.to,
            from: rqHeaders.from,
            'call-id': callId,
            cseq: { method: 'ACK', seq: cseqObj.seq },
            'max-forwards': 70,
            'content-length': 0,
          },
        });
        setTimeout(sendBye, 500);
      } else if (status === 487) {
        finish(true);
      } else if (status === 603) {
        finish(true);
      } else if (status >= 400) {
        logger.error({ status, reason: rs.reason }, 'SIP call failed');
        finish(false, `SIP ${status}: ${rs.reason}`);
      }
    };

    const rq = buildInvite();
    logger.info({ target: targetUri, caller: caller.id }, 'SIP call initiated');
    sip.send(rq, (rs: Record<string, unknown>) => handleResponse(rq, rs));
  });
}
