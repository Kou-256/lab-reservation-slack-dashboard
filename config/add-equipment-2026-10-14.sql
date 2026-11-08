
INSERT INTO resources(id,channel_id,name,type,capacity,enabled,multi_day,purpose_options,created_at,updated_at)
SELECT 'furnace_blue',channel_id,'電気炉(青)','exclusive_room',1,1,1,'["YVO4試料作製","BiVO4粉末作成","自由入力"]',unixepoch()*1000,unixepoch()*1000 FROM resources WHERE id='stirrer'
ON CONFLICT(id) DO NOTHING;
INSERT INTO resources(id,channel_id,name,type,capacity,enabled,multi_day,purpose_options,created_at,updated_at)
SELECT 'furnace_silver',channel_id,'電気炉(銀)','exclusive_room',1,1,1,'["YVO4試料作製","BiVO4粉末作成","自由入力"]',unixepoch()*1000,unixepoch()*1000 FROM resources WHERE id='stirrer'
ON CONFLICT(id) DO NOTHING;
INSERT INTO resources(id,channel_id,name,type,capacity,enabled,multi_day,purpose_options,created_at,updated_at)
SELECT 'printer_3d',channel_id,'3Dプリンタ','exclusive_room',1,1,1,'[]',unixepoch()*1000,unixepoch()*1000 FROM resources WHERE id='stirrer'
ON CONFLICT(id) DO NOTHING;
UPDATE resources SET capacity=16,revision=revision+1,updated_at=unixepoch()*1000 WHERE id='stirrer' AND capacity IS NOT 16;
