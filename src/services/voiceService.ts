import twilio from 'twilio';
import { twilioClient } from './twilioClient.js';
import { ringViaSip } from './sipCallService.js';
import { env, callers } from '../config/index.js';
import { logger } from '../utils/index.js';
import type { VoiceCallOptions, CallResult } from '../types/index.js';

const { VoiceResponse } = twilio.twiml;

const E164_REGEX = /^\+[1-9]\d{1,14}$/;

const TWILIO_ERROR_MESSAGES: Record<number, string> = {
  21211: 'Invalid phone number',
  21214: 'Phone number not verified (trial account limitation)',
  21608: 'Unverified caller ID',
};

export function validatePhoneNumber(phone: string): boolean {
  return E164_REGEX.test(phone);
}

export function generateTwiML(message: string): string {
  const response = new VoiceResponse();
  response.say(message);
  return response.toString();
}

async function makeCallViaTwilio(options: VoiceCallOptions): Promise<CallResult> {
  const { to, message } = options;

  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_PHONE_NUMBER) {
    return { success: false, error: 'Twilio credentials not configured' };
  }

  const twimlContent = generateTwiML(message);
  logger.info({ to, provider: 'twilio' }, 'Initiating voice call');

  try {
    const call = await twilioClient.calls.create({
      twiml: twimlContent,
      to,
      from: env.TWILIO_PHONE_NUMBER,
    });

    logger.info({ callSid: call.sid, to }, 'Call initiated successfully');
    return { success: true, callSid: call.sid };
  } catch (error) {
    const twilioError = error as { code?: number; message?: string };
    logger.error({ error: twilioError, to }, 'Twilio call failed');

    const errorMessage = twilioError.code ? TWILIO_ERROR_MESSAGES[twilioError.code] : undefined;
    return {
      success: false,
      error: errorMessage || twilioError.message || 'Failed to initiate call',
      errorCode: twilioError.code,
    };
  }
}

async function makeCallViaSip(): Promise<CallResult> {
  const caller = callers[0];
  if (!caller) {
    return { success: false, error: 'No caller configured in callers.json' };
  }
  logger.info({ provider: 'sip', caller: caller.id }, 'Initiating SIP ring');
  return ringViaSip(caller);
}

export async function makeCall(options: VoiceCallOptions): Promise<CallResult> {
  if (env.CALL_PROVIDER === 'sip') {
    return makeCallViaSip();
  }

  if (!validatePhoneNumber(options.to)) {
    return {
      success: false,
      error: 'Invalid phone number format. Use E.164 format (+1234567890)',
    };
  }

  return makeCallViaTwilio(options);
}
