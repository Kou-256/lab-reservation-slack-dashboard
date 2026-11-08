-- 複数タブレットの定期取得で、終了済みの過去履歴を毎回走査しないための索引。
CREATE INDEX reservations_dashboard_end ON reservations(status,end_at,start_at,resource_id);
