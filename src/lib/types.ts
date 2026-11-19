// Core domain types. Mirrors the relational schema in supabase/migrations.
// All datetimes are ISO-8601 UTC strings; the baby's IANA time zone is used for display & day bucketing.

export type ID = string;
export type Sex = 'male' | 'female';
export type FeedingPreference = 'breast' | 'formula' | 'combination';
export type FeedingType = 'breast' | 'expressed' | 'formula';
export type Role = 'owner' | 'caregiver';
export type InvitationStatus = 'pending' | 'accepted' | 'revoked' | 'declined';

export interface User {
  user_id: ID;
  email: string;
  display_name: string;
  created_at: string;
  updated_at: string;
}

export interface BabyProfile {
  baby_id: ID;
  name: string;
  date_of_birth: string; // YYYY-MM-DD (local calendar date)
  time_of_birth?: string | null; // HH:mm
  sex: Sex;
  gestational_age_weeks?: number | null;
  gestational_age_days?: number | null;
  timezone: string; // IANA
  photograph_url?: string | null; // data URL locally; storage path in Supabase
  feeding_preference: FeedingPreference;
  birth_weight_grams?: number | null;
  birth_length_mm?: number | null;
  birth_head_circumference_mm?: number | null;
  created_by: ID;
  created_at: string;
  updated_at: string;
}

export interface BabyAccess {
  access_id: ID;
  baby_id: ID;
  user_id: ID | null; // null until accepted
  invited_email: string;
  role: Role;
  invitation_status: InvitationStatus;
  invited_by: ID;
  created_at: string;
  updated_at: string;
}

interface Audited {
  baby_id: ID;
  created_by: ID;
  updated_by: ID;
  created_at: string;
  updated_at: string;
  deleted_at?: string | null; // soft delete for sync & audit
}

export interface FeedingEntry extends Audited {
  feed_id: ID;
  feeding_type: FeedingType;
  start_datetime: string;
  end_datetime?: string | null;
  duration_seconds?: number | null;
  breast_side?: 'left' | 'right' | 'both' | null; // which breast(s), recordable without the timer
  left_duration_seconds?: number | null;
  right_duration_seconds?: number | null;
  quantity_ml?: number | null;
  observations: string[];
  notes?: string | null;
}

export type PooColour = 'yellow' | 'green' | 'brown' | 'pale' | 'black' | 'red' | 'other';
export type PooSize = 'small' | 'medium' | 'large';
export type PooTexture = 'soft' | 'loose' | 'firm' | 'other';

export interface PooEntry extends Audited {
  poo_id: ID;
  datetime: string;
  colour?: PooColour | null;
  size?: PooSize | null;
  texture?: PooTexture | null;
  notes?: string | null;
}

export interface Pause { start: string; end?: string | null }

export interface SleepEntry extends Audited {
  sleep_id: ID;
  start_datetime: string;
  end_datetime?: string | null;
  duration_seconds?: number | null; // excludes paused time
  status: 'active' | 'paused' | 'completed';
  pauses: Pause[];
  notes?: string | null;
}

export interface GrowthMeasurement extends Audited {
  measurement_id: ID;
  measurement_date: string; // YYYY-MM-DD
  weight_grams?: number | null;
  length_mm?: number | null;
  head_circumference_mm?: number | null;
  notes?: string | null;
}

/** A breastfeeding timer that persists across app restarts (PRD 7.3). */
export interface FeedTimer {
  baby_id: ID;
  started_at: string;
  side: 'left' | 'right' | null;
  // accumulated seconds per side for segments that have ended
  left_seconds: number;
  right_seconds: number;
  unsided_seconds: number;
  segment_started_at: string | null; // null when paused
  created_by: ID;
}

export interface UserPrefs {
  time_format: '24h' | '12h';
  units: 'metric' | 'imperial';
  notifications: { feeding: boolean; sleep: boolean; custom: boolean; feeding_interval_min: number };
  language: 'en';
  ai_consent: boolean;
}

export type EntryKind = 'feed' | 'poo' | 'sleep' | 'growth';

export interface AIInsight {
  insight_id: string;
  baby_id: ID;
  insight_type: 'observation' | 'prediction';
  category: 'sleep' | 'feeding' | 'poo' | 'overview';
  title: string;
  description: string;
  evidence_level: 'preliminary' | 'emerging' | 'recurring';
  observation_count: number;
  days_covered: number;
  date_range_start: string;
  date_range_end: string;
  generated_at: string;
  // predictions
  predicted_at?: string;
  uncertainty_minutes?: number;
  limited_data_note?: string;
  histogram?: number[];
}
