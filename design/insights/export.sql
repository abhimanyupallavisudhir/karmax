-- One organization's rows for scripts/insights-from-export.ts (read-only). On the
-- production host: ssh … "sudo -n docker exec -i karmax-postgresql-1 psql -U temporal -d karmax -At" < export.sql > export.json
-- Set O to the organization. Other organizations' managed machines are anonymized (budgets only).
\set O 'org_mttzkp0z5c0d94e74f'
SELECT json_build_object(
 'organizations', (SELECT json_agg(json_build_object('id',id,'name',name,'slug',slug,'kind',kind,'plan',plan,'createdAt',"createdAt",'storagePacks',"storagePacks",'computePacks',"computePacks")) FROM organizations WHERE id=:'O'),
 'memberships', (SELECT count(*) FROM organization_memberships WHERE "organizationId"=:'O'),
 'projects', (SELECT json_agg(json_build_object('id',id,'organizationId',"organizationId",'name',name,'createdAt',"createdAt",'config','{}','ord',ord)) FROM projects WHERE "organizationId"=:'O'),
 'tasks', (SELECT json_agg(json_build_object('id',t.id,'projectId',t."projectId",'listId',t."listId",'title',t.title,'workflow',t.workflow,'workflowVersion',t."workflowVersion",
    'params', json_build_object('draft',(t.params::json->>'draft')::boolean,'archived',(t.params::json->>'archived')::boolean)::text,
    'createdAt',t."createdAt",'ord',t.ord,'parentTaskId',t."parentTaskId",'completedAt',t."completedAt",'num',t.num,
    'lastView', CASE WHEN t."lastView" IS NULL THEN NULL ELSE json_build_object('stage',t."lastView"::json->>'stage','status',t."lastView"::json->>'status','waitingFor',json_build_object('kind',t."lastView"::json->'waitingFor'->>'kind'))::text END))
    FROM tasks t JOIN projects p ON p.id=t."projectId" WHERE p."organizationId"=:'O'),
 'usage_events', (SELECT json_agg(u) FROM usage_events u WHERE "organizationId"=:'O' AND kind<>'agent.request'),
 'usage_admissions', (SELECT json_agg(a) FROM usage_admissions a WHERE "organizationId"=:'O'),
 'routed', (SELECT json_agg(json_build_object('taskId',e."taskId",'type',e.type,'ts',e.ts,'payload',e.payload)) FROM events e JOIN tasks t ON t.id=e."taskId" JOIN projects p ON p.id=t."projectId" WHERE p."organizationId"=:'O' AND e.type='world.routed'),
 'kv', (SELECT json_agg(json_build_object('k',k,'v',v)) FROM kv WHERE k IN (
    SELECT DISTINCT pre || (metadata::json->>'account') FROM usage_events, (VALUES ('quota:observed:'),('quota:capacity:'),('quota:spent:'),('usage:')) AS x(pre)
    WHERE "organizationId"=:'O' AND kind='agent.tokens' AND metadata::json->>'account' IS NOT NULL)),
 'storage_locations', (SELECT json_agg(s) FROM storage_locations s WHERE "organizationId"=:'O'),
 'world_checkpoints', (SELECT json_agg(json_build_object('id',w.id,'worldId',w."worldId",'generation',w.generation,'projectId',w."projectId",'manifest',json_build_object('id',w.id,'filesystemDelta',w.manifest::json->'filesystemDelta')::text,'createdAt',w."createdAt"))
    FROM world_checkpoints w JOIN projects p ON p.id=w."projectId" WHERE p."organizationId"=:'O' AND w.id NOT IN (SELECT substr(k,15) FROM kv WHERE k LIKE 'checkpoint-gc:%')),
 'resource_attachments', (SELECT json_agg(r) FROM resource_attachments r WHERE "organizationId"=:'O'),
 'resource_revisions', (SELECT json_agg(r) FROM resource_revisions r JOIN resource_attachments a ON a.id=r."attachmentId" WHERE a."organizationId"=:'O'),
 'repo_bytes', (SELECT json_agg(json_build_object('attachmentId',"attachmentId",'storageLocationId',"storageLocationId",'bytes',b)) FROM (SELECT "attachmentId","storageLocationId",sum(bytes) b FROM resource_repository_files WHERE "organizationId"=:'O' AND kind<>'locks' GROUP BY 1,2) x),
 'chunk_bytes', (SELECT json_agg(json_build_object('storageLocationId',"storageLocationId",'bytes',b)) FROM (SELECT "storageLocationId",sum(bytes) b FROM resource_snapshot_chunks WHERE "organizationId"=:'O' GROUP BY 1) x),
 'promoted_artifacts', (SELECT json_agg(a) FROM promoted_artifacts a WHERE "organizationId"=:'O'),
 'compute_pack_gifts', (SELECT json_agg(g) FROM compute_pack_gifts g WHERE "organizationId"=:'O'),
 'storage_pack_gifts', (SELECT json_agg(g) FROM storage_pack_gifts g WHERE "organizationId"=:'O'),
 'compute_topups', (SELECT json_agg(g) FROM compute_topups g WHERE "organizationId"=:'O'),
 'compute_holds', (SELECT json_agg(g) FROM compute_holds g WHERE "organizationId"=:'O' AND "startedAt">1793400000000),
 'managed_all', (SELECT json_agg(json_build_object('organizationId', CASE WHEN "organizationId"=:'O' THEN "organizationId" ELSE 'org_others' END,'provider',provider,'startedAt',"startedAt",'endedAt',"endedAt",'cpu',metadata::json->>'cpu')) FROM usage_events WHERE "fundingSource"='managed' AND kind='world.active' AND "organizationId"<>:'O' AND "startedAt">1790000000000)
);
