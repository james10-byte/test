import { z } from 'zod';

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export const iconSettingsSchema = z
  .object({
    background: z.union([z.literal('transparent'), z.string().regex(HEX_COLOR)]).optional(),
    adaptiveBackground: z.string().regex(HEX_COLOR).optional(),
    scale: z.number().min(0.1).max(1).optional(),
    padding: z.number().min(0).max(0.4).optional(),
    offsetX: z.number().min(-0.5).max(0.5).optional(),
    offsetY: z.number().min(-0.5).max(0.5).optional(),
    fit: z.enum(['contain', 'cover']).optional()
  })
  .strict();

export const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0)
});

export const buildIdPattern = /^[a-f0-9]{32}$/;
export const clientTokenPattern = /^[A-Za-z0-9_-]{32,128}$/;
