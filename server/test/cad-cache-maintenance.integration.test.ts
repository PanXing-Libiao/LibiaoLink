import "reflect-metadata";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { AppConfig } from "../src/config/config.module.js";
import { loadEnv } from "../src/config/env.js";
import { DatabaseService } from "../src/db/database.service.js";
import { CadArchiveRepository } from "../src/modules/file/cad-archive.repository.js";
import { CadCacheMaintenance } from "../src/modules/file/cad-cache-maintenance.js";
import { CAD_FORMAT_COMPAT_VERSIONS } from "../src/modules/file/cad-release.js";
import { installCadAuditTables } from "./cad-audit.fixture.js";
const databaseUrl=process.env.CAD_TEST_DATABASE_URL, actorId=randomUUID(), projectId=randomUUID();
const schemaName='cad_cache_'+randomBytes(8).toString('hex');
let database:DatabaseService,admin:Pool,archive:CadArchiveRepository;
const engine={enabled:true,dwgEnabled:true,inputLimit:64*1024**2},purgePrefix=vi.fn(async (_prefix:string)=>{});
const maintenance=()=>new CadCacheMaintenance(database,archive,engine as never,{purgePrefix} as never);
const query=(s:string,args:unknown[]=[])=>database.pool.query(s,args);
async function oldArtifact(name='box.step') {
 const source={fileId:randomUUID(),versionId:randomUUID(),sourceSHA256:'1'.repeat(64),sourceBytes:3,sourceName:name};
 await query('insert into files(id,project_id) values($1,$2)',[source.fileId,projectId]);
 await query('insert into file_versions(id) values($1)',[source.versionId]);
 const artifact=await archive.request(source,name.endsWith('.dwg')?'UTF8':'GB');
 const prefix=`projects/${projectId}/files/${source.fileId}/cad/${artifact.id}/${randomUUID()}/`;
 await query("update cad_artifacts set format_version='old',created_at=now()-interval '2 days',last_accessed_at=now()-interval '1 day',object_prefix=$2 where id=$1",[artifact.id,prefix]);
 return {source,artifact,prefix};
}
async function replacement(source:Parameters<typeof archive.request>[0],ready=true) {
 const row=await archive.request(source,source.sourceName.endsWith('.dwg')?'UTF8':'GB');
 if(ready)await query("update cad_artifacts set state='completed',object_prefix=$2,manifest_sha256=$3,manifest_bytes=1,resource_lease=$4,buffers='[]'::jsonb where id=$1",[row.id,`projects/${projectId}/files/${source.fileId}/cad/${row.id}/${randomUUID()}/`,'a'.repeat(64),'b'.repeat(48)]);
 return row;
}
async function currentCad(name:string,extension:string,status='draft') {
 const fileId=randomUUID(),versionId=randomUUID(),hash=randomBytes(32).toString('hex');
 await query('insert into files(id,project_id,status,name,current_version_id) values($1,$2,$3,$4,$5)',[fileId,projectId,status,name,versionId]);
 await query('insert into file_versions(id,file_id,object_key,size_bytes,content_hash,uploaded_at) values($1,$2,$3,3,$4,now())',[versionId,fileId,`objects/${versionId}.${extension}`,hash]);
 return {fileId,versionId};
}
const exists=async(id:string)=>(await query('select id from cad_artifacts where id=$1',[id])).rowCount;
const pending=async()=>(await query('select * from cad_retired_objects')).rows;
describe.skipIf(!databaseUrl)('CAD bounded cache lifecycle with PostgreSQL',()=>{
 beforeAll(async()=>{
  const target=new URL(databaseUrl!);
  if(!['localhost','127.0.0.1'].includes(target.hostname)||!target.pathname.startsWith('/libiaolink_cad_test'))throw Error('Dedicated local CAD database required');
  admin=new Pool({connectionString:databaseUrl});await admin.query(`create schema ${schemaName}`);
  target.searchParams.set('options','-c search_path='+schemaName);
  database=new DatabaseService(new AppConfig(loadEnv({NODE_ENV:'test',DATABASE_URL:target.toString()})));
  await installCadAuditTables(database,actorId);archive=new CadArchiveRepository(database,{} as never);
 });
 beforeEach(async()=>{await query('truncate cad_views,cad_artifacts,cad_retired_objects,file_versions,files cascade');purgePrefix.mockReset();purgePrefix.mockResolvedValue();engine.dwgEnabled=true;engine.enabled=true;});
 afterAll(async()=>{await database?.onApplicationShutdown();if(admin){await admin.query(`drop schema if exists ${schemaName} cascade`);await admin.end();}});
 it('bounds recent warmup, preserves identity/use time, excludes cold/unseen and existing failed jobs',async()=>{
  const cold=await oldArtifact(),unseen=await oldArtifact(),failed=await oldArtifact();
  await query("update cad_artifacts set last_accessed_at=now()-interval '8 days' where id=$1",[cold.artifact.id]);
  await query('update cad_artifacts set last_accessed_at=null where id=$1',[unseen.artifact.id]);
  const current=await replacement(failed.source,false);await query("update cad_artifacts set state='failed' where id=$1",[current.id]);
  for(let i=0;i<4;i++)await oldArtifact();
  await maintenance().warmRecent();
  const rows=(await query("select * from cad_artifacts where format_version<>'old' and state='queued'")).rows;
  expect(rows).toHaveLength(2);expect(rows.every(r=>r.last_accessed_at.getTime()<Date.now()-3600_000&&r.attempts===0&&r.object_prefix===null)).toBe(true);
  expect(rows.some(r=>[cold.source.versionId,unseen.source.versionId,failed.source.versionId].includes(r.version_id))).toBe(false);
  expect((await query('select state from cad_artifacts where id=$1',[current.id])).rows[0].state).toBe('failed');
 });
 it('discovers current STEP/STP/DWG without cache and ignores recycled or unsupported files',async()=>{
  const step=await currentCad('零件.STEP','step'),stp=await currentCad('装配.stp','stp'),dwg=await currentCad('总图.dwg','dwg');
  const recycled=await currentCad('回收.dwg','dwg','recycled'),unsupported=await currentCad('参考.iges','iges');
  await maintenance().warmUncached();
  const rows=(await query('select * from cad_artifacts')).rows,byFile=new Map(rows.map(row=>[row.file_id,row]));
  expect(rows).toHaveLength(3);
  expect(byFile.get(step.fileId)).toMatchObject({source_format:'STEP',name_codepage:'GB',state:'queued'});
  expect(byFile.get(stp.fileId)).toMatchObject({source_format:'STEP',name_codepage:'GB',state:'queued'});
  expect(byFile.get(dwg.fileId)).toMatchObject({source_format:'DWG',name_codepage:'UTF8',state:'queued'});
  expect(byFile.has(recycled.fileId)).toBe(false);expect(byFile.has(unsupported.fileId)).toBe(false);
  await maintenance().warmUncached();expect((await query('select id from cad_artifacts')).rowCount).toBe(3);
 });
 it('respects disabled DWG and compatible cached formats during discovery',async()=>{
  const step=await currentCad('旧图.step','step'),dwg=await currentCad('旧图.dwg','dwg');
  await maintenance().warmUncached();
  const cached=(await query('select id from cad_artifacts where file_id=$1',[step.fileId])).rows[0];
  await query('update cad_artifacts set format_version=$2 where id=$1',[cached.id,CAD_FORMAT_COMPAT_VERSIONS.STEP[0]]);
  engine.dwgEnabled=false;await query('delete from cad_artifacts where file_id=$1',[dwg.fileId]);
  await maintenance().warmUncached();
  expect((await query('select file_id from cad_artifacts order by file_id')).rows).toEqual([{file_id:step.fileId}]);
 });
 it('opening records use; recycled files and disabled DWG are not prewarmed; concurrent warmup is idempotent',async()=>{
  const recycled=await oldArtifact(),dwg=await oldArtifact('box.dwg'),opened=await oldArtifact();
  await query("update files set status='recycled' where id=$1",[recycled.source.fileId]);engine.dwgEnabled=false;
  await archive.openView(opened.artifact.id,actorId,'a'.repeat(32));
  expect((await query('select last_accessed_at from cad_artifacts where id=$1',[opened.artifact.id])).rows[0].last_accessed_at.getTime()).toBeGreaterThan(Date.now()-2000);
  await Promise.all([maintenance().warmRecent(),maintenance().warmRecent()]);
  expect((await query("select version_id from cad_artifacts where format_version<>'old'")).rows).toEqual([{version_id:opened.source.versionId}]);expect(await exists(dwg.artifact.id)).toBe(1);
 });
 it('requires ready replacement and no live window/lease, then durably retires once with a grace period',async()=>{
  const old=await oldArtifact();await replacement(old.source,false);
  await maintenance().retireReplaced();expect(await exists(old.artifact.id)).toBe(1);
  await replacement(old.source);const view=await archive.openView(old.artifact.id,actorId,'b'.repeat(32));
  await maintenance().retireReplaced();expect(await exists(old.artifact.id)).toBe(1);
  await query("update cad_views set cancelled=true,lease_expires_at=now()+interval '5 minutes' where id=$1",[view.id]);
  await maintenance().retireReplaced();expect(await exists(old.artifact.id)).toBe(1);
  await query('update cad_views set lease_expires_at=null where id=$1',[view.id]);
  await Promise.all([maintenance().retireReplaced(),maintenance().retireReplaced()]);
  expect(await exists(old.artifact.id)).toBe(0);expect(await pending()).toHaveLength(1);
  expect((await pending())[0].prefix).toBe(old.prefix);expect((await pending())[0].available_at.getTime()).toBeGreaterThan(Date.now()+23*3600_000);
  await maintenance().purgeRetired();expect(purgePrefix).not.toHaveBeenCalled();
 });
 it('retains different encodings, newer generations and actively claimed conversions',async()=>{
  const old=await oldArtifact(),current=await replacement(old.source);
  await query("update cad_artifacts set name_codepage='UTF8' where id=$1",[current.id]);
  await maintenance().retireReplaced();expect(await exists(old.artifact.id)).toBe(1);
  await query("update cad_artifacts set name_codepage='GB',created_at=now()-interval '3 days' where id=$1",[current.id]);
  await maintenance().retireReplaced();expect(await exists(old.artifact.id)).toBe(1);
  await query('update cad_artifacts set created_at=now() where id=$1',[current.id]);
  await query("update cad_artifacts set state='running',claim_until=now()+interval '1 hour' where id=$1",[old.artifact.id]);
  await maintenance().retireReplaced();expect(await exists(old.artifact.id)).toBe(1);
 });
 it('keeps failed deletion across instances and concurrent retries only delete the recorded prefix',async()=>{
  const old=await oldArtifact();await replacement(old.source);await maintenance().retireReplaced();
  await query("update cad_retired_objects set available_at=now()-interval '1 second'");purgePrefix.mockRejectedValueOnce(Error('storage unavailable'));
  await maintenance().purgeRetired();expect(await pending()).toHaveLength(1);
  await maintenance().purgeRetired();expect(purgePrefix).toHaveBeenCalledTimes(1);
  await query("update cad_retired_objects set available_at=now()-interval '1 second'");
  await Promise.all([maintenance().purgeRetired(),maintenance().purgeRetired()]);
  expect(purgePrefix).toHaveBeenCalledTimes(2);expect(purgePrefix).toHaveBeenLastCalledWith(old.prefix);expect(await pending()).toEqual([]);
 });
 it('an opening holding the artifact lock wins against retirement',async()=>{
  const old=await oldArtifact();await replacement(old.source);const connection=await database.pool.connect();await connection.query('begin');
  try{
   await connection.query('select id from cad_artifacts where id=$1 for update',[old.artifact.id]);
   const opening=archive.openView(old.artifact.id,actorId,'c'.repeat(32));
   await maintenance().retireReplaced();expect(await exists(old.artifact.id)).toBe(1);
   await connection.query('commit');await opening;await maintenance().retireReplaced();expect(await exists(old.artifact.id)).toBe(1);
  }finally{await connection.query('rollback');connection.release();}
 });
 it('DXF companion sets remain separate during warmup and retirement',async()=>{
  const old=await oldArtifact('main.dxf');
  const companion={fileId:randomUUID(),versionId:randomUUID(),path:'detail.dxf',sourceSHA256:'2'.repeat(64),sourceBytes:2};
  await replacement({...old.source,companions:[companion]});
  await maintenance().retireReplaced();expect(await exists(old.artifact.id)).toBe(1);
  await maintenance().warmRecent();
  const rows=(await query("select companions,state from cad_artifacts where version_id=$1 and format_version<>'old'",[old.source.versionId])).rows;
  expect(rows).toHaveLength(2);expect(rows.some(row=>row.companions.length===0&&row.state==='queued')).toBe(true);
 });
 it('upgrade retains known access history without inventing use for unseen artifacts',async()=>{
  const connection=await database.pool.connect(),upgradeSchema=schemaName+'_upgrade';
  await connection.query('begin');
  try{
   await connection.query(`create schema ${upgradeSchema}`);await connection.query(`set local search_path=${upgradeSchema}`);
   await connection.query('create table cad_artifacts(id uuid primary key);create table cad_views(artifact_id uuid,last_seen_at timestamptz)');
   const seen=randomUUID(),unseen=randomUUID();
   await connection.query('insert into cad_artifacts values($1),($2)',[seen,unseen]);
   await connection.query("insert into cad_views values($1,now()-interval '1 day'),($2,'1970-01-01')",[seen,unseen]);
   await connection.query(await readFile(new URL('../../database/migrations/0081_cad_cache_lifecycle.sql',import.meta.url),'utf8'));
   const rows=(await connection.query('select * from cad_artifacts')).rows;
   expect(rows.find(r=>r.id===seen).last_accessed_at).toBeInstanceOf(Date);expect(rows.find(r=>r.id===unseen).last_accessed_at).toBeNull();
  }finally{await connection.query('rollback');connection.release();}
 });
 it('rate limits idle maintenance and respects disabled engine',async()=>{
  const m=maintenance(),warm=vi.spyOn(m,'warmRecent').mockResolvedValue(),retire=vi.spyOn(m,'retireReplaced').mockResolvedValue(),purge=vi.spyOn(m,'purgeRetired').mockResolvedValue();
  engine.enabled=false;await m.runIfDue();expect(warm).not.toHaveBeenCalled();
  engine.enabled=true;await m.runIfDue();await m.runIfDue();expect(warm).toHaveBeenCalledTimes(1);expect(retire).toHaveBeenCalledTimes(1);expect(purge).toHaveBeenCalledTimes(1);
 });
});
