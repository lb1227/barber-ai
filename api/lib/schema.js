import { z } from 'zod';

export const receptionistConfigSchema = z.object({
  name: z.string().min(1).max(100),
  greeting: z.string().min(1).max(500),
  voice: z.string().min(1).max(40),
  rate: z.number().min(0.5).max(2.0),
  barge_in: z.boolean(),
  end_silence_ms: z.number().min(200).max(5000),
  timezone: z.string().min(1).max(100),
  phone: z.string().max(40).optional().default(''),
});
