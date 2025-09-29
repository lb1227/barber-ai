import { supaAdmin } from './supa.js';

export async function getConfigForUser(userId) {
  const { data, error } = await supaAdmin
    .from('receptionist_config')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  // defaults if first-time user
  return data ?? {
    user_id: userId,
    name: 'Barber AI Receptionist',
    greeting: 'Hello, thank you for calling the barbershop! How can I help you today.',
    voice: 'alloy',
    rate: 1.0,
    barge_in: true,
    end_silence_ms: 1000,
    timezone: 'America/New_York',
    phone: ''
  };
}

export async function upsertConfigForUser(userId, cfg) {
  const payload = { user_id: userId, ...cfg };
  const { error } = await supaAdmin
    .from('receptionist_config')
    .upsert(payload)
    .select('user_id'); // surface errors
  if (error) throw error;
}
