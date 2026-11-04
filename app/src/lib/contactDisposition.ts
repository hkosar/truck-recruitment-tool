/** Outcome to send: the chosen one if the channel allows it, else the channel's first option. */
import { DISPOSITIONS_BY_CHANNEL } from '../types/domain';
import type { Channel, ContactDisposition } from '../types/domain';

type LoggableChannel = Extract<Channel, 'call' | 'text' | 'email'>;

export function resolveDisposition(channel: LoggableChannel, chosen: unknown): ContactDisposition {
  const allowed = DISPOSITIONS_BY_CHANNEL[channel];
  return allowed.find((value) => value === chosen) ?? allowed[0];
}
