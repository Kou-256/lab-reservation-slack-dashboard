
INSERT INTO resources(id,channel_id,name,type,capacity,enabled,multi_day,purpose_options,created_at,updated_at,icon)
SELECT 'centrifuge',channel_id,'遠心分離機(実験室B)','exclusive_room',1,1,1,'[]',unixepoch()*1000,unixepoch()*1000,'🌀'
FROM resources WHERE id='stirrer'
ON CONFLICT(id) DO NOTHING;
