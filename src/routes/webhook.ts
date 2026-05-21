import { Router } from 'express';
import { makeCall } from '../services/index.js';
import { env } from '../config/index.js';

const router = Router();

router.get('/webhook', async (req, res, next) => {
  try {
    if (!env.CALL_TO_NUMBER) {
      res.status(400).json({ success: false, error: 'CALL_TO_NUMBER not configured' });
      return;
    }

    const result = await makeCall({
      to: env.CALL_TO_NUMBER,
      message: 'You have a new alert.',
    });

    if (result.success) {
      res.status(202).json({ success: true, callSid: result.callSid });
    } else {
      res.status(400).json({ success: false, error: result.error, errorCode: result.errorCode });
    }
  } catch (error) {
    next(error);
  }
});

export default router;
