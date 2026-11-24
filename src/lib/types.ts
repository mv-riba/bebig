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
  wet_tracking?: boolean; // when on, the Poo log becomes "Nappy" with Wet / Poo / Both
  birth_weight_grams?: number | null;
  birth_length_mm?: number | null;
  birth_head_circumference_mm?: number | null;
  created_by: ID | null; // null once that person deleted their account
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
  invited_by: ID | null;
  created_at: string;
  updated_at: string;
  keeps_free_access?: boolean; // server-maintained: the caregiver who keeps access on the free plan (migration 0006)
}

interface Audited {
  baby_id: ID;
  created_by: ID | null; // null once that person deleted their account
  updated_by: ID | null;
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

export type NappyType = 'poo' | 'wet' | 'both';
export interface PooEntry extends Audited {
  poo_id: ID;
  datetime: string;
  nappy_type?: NappyType | null; // null/undefined = 'poo' (records from before wet tracking)
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

/** A running breastfeeding or extras ("How long") timer. Shared with the other caregivers through the server
 *  (table running_timers, changed only by the timer_* actions in migration 0008), and kept until it's saved or
 *  discarded, so it survives app restarts (PRD 7.3). */
export interface RunningTimer {
  timer_id: ID;
  baby_id: ID;
  kind: 'feed' | 'extra';
  tracker_id: ID | null; // extras only
  started_at: string;
  side: 'left' | 'right' | null; // feed only: the side being timed now
  // seconds of stretches that have ended, per side (extras use unsided_seconds)
  left_seconds: number;
  right_seconds: number;
  unsided_seconds: number;
  segment_started_at: string | null; // start of the current stretch; null while paused
  ended_at: string | null; // set once saved or discarded
  end_kind: 'saved' | 'discarded' | null;
  entry_id: ID | null; // the feed / extras entry the winning Stop saved
  created_by: ID | null; // null once that person deleted their account
  updated_by: ID | null;
  created_at: string;
  updated_at: string;
  server_updated_at?: string;
}
/** The breastfeeding timer (a running timer of kind 'feed'). */
export type FeedTimer = RunningTimer;

export interface UserPrefs {
  time_format: '24h' | '12h';
  units: 'metric' | 'imperial';
  notifications: { feeding: boolean; sleep: boolean; custom: boolean; feeding_interval_min: number };
  language: 'en';
  ai_consent: boolean;
  show_extras?: boolean; // show extras & wet nappies in timelines (default on)
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

// ---------- Extra trackers (optional, opt-in) ----------
/** What a tracker records: just the time, a once-a-day check-off, a number with a unit, a duration, or a level. */
export type TrackerKind = 'event' | 'daily' | 'amount' | 'duration' | 'level';
export type TrackerIcon = 'drop' | 'wind' | 'pill' | 'sun' | 'heart' | 'star' | 'bath';
export interface TrackerDef extends Audited {
  tracker_id: ID;
  name: string;
  icon: TrackerIcon;
  kind: TrackerKind;
  unit?: string | null; // for 'amount'
  preset?: 'bath' | 'congestion' | null;
  enabled: boolean;
  sort: number;
}
export type Level = 'mild' | 'moderate' | 'strong';
export interface ExtraEntry extends Audited {
  extra_id: ID;
  tracker_id: ID;
  datetime: string;
  duration_seconds?: number | null; // 'duration'
  value_num?: number | null; // 'amount'
  level?: Level | null; // 'level'
  notes?: string | null;
}
