export interface Env extends Pick<Cloudflare.Env, 'DB' | 'SLACK_TEAM_ID' | 'SLACK_APP_ID'> {
  SLACK_BOT_TOKEN: string;
  SLACK_SIGNING_SECRET: string;
  ADMIN_TOKEN: string;
  OPERATIONS_CHANNEL_ID?: string;
  SCHEDULE_CHANNEL_ID?: string;
  GOOGLE_CALENDAR_ID?: string;
  SCHEDULE_GOOGLE_CALENDAR_ID?: string;
  PROFESSOR_GOOGLE_CALENDAR_ID?: string;
  GOOGLE_SERVICE_ACCOUNT_JSON?: string;
  ADMIN_USER_IDS?: string;
  RESTORE_MODE?: string;
  ASSETS?: Fetcher;
  DASHBOARD_SECRET?: string;
  DASHBOARD_DEVICE_KEY?: string;
}
export interface ResourcePool {id:string;name:string;capacity:number}
export interface Resource {
  booking_pools?:string;pools?:ResourcePool[];
  equipment_label?:string;room?:string;
  members?:{id:string;name:string}[];
  id: string; channel_id: string; name: string;
  type: 'exclusive_room' | 'quantity_resource'; capacity: number | null;
  enabled: number; multi_day: number; purpose_options: string; revision: number;
  schedule_event?: number; icon?: string;
  maintenance_reason?: string | null;
  maintenance_id?: string | null;
  maintenance_kind?: string | null;
  maintenance_quantity?: number;
}
export interface Reservation {
  pool_id?:string|null;
  maintenance_warning?:string;
  presenters?:string;online_url?:string;
  location?: string;
  id: string; resource_id: string; slack_user_id: string; slack_user_name: string;
  start_at: number; end_at: number; quantity: number; purpose: string; purpose_choice: string;
  status: 'active' | 'cancelled'; version: number; created_at: number; updated_at: number;
}
export interface Booking {
  pool_id?:string|null;
  presenters?:string[];online_url?:string;
  location?: string;
  start_at: number; end_at: number; quantity: number; purpose: string; purpose_choice: string;
}
export type Operation = 'created' | 'updated' | 'cancelled';
export interface Change {
  finished?: boolean;
  resource: Resource; before: Reservation | null; after: Reservation;
}
export interface Receipt {
  request_key: string; reservation_id: string; resource_id: string; slack_user_id: string;
  operation: Operation; payload: string; processed_at: number;
}
export interface Notification extends Receipt {
  status: 'pending' | 'sending' | 'sent' | 'failed'; error: string | null;
}
// Slack's Block Kit payloads are heterogeneous JSON; business and DB models remain typed.
export type SlackJSON = Record<string, any>;
export type SlackCall = (method: string, payload: SlackJSON) => Promise<SlackJSON>;
