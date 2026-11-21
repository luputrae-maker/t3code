import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {candidateTargets} from './router.mjs';
import * as quota from './quota.mjs';

const now = Date.parse('2026-11-21T08:28:44Z');
const opencodeError = 'OpenCode Go 5 hour usage limit reached. Switch to a free model, or turn on Extra Usage on the Go page in OpenCode Console to keep going.';
const failure = {
 status:'failed', workState:'result_available', hasPendingChildRuns:false,
 hasPendingQuestion:false, pendingApproval:null,
 childThreadId:'child', childRunId:'run', latestTerminalRunId:'run',
 providerInstanceId:'opencode', model:'opencode-go/kimi-k3.1-pro', summary:opencodeError,
};

test('a confirmed native quota hold survives reload and keeps Cursor and free models eligible', () => {
 const directory = fs.mkdtempSync(path.join(os.tmpdir(),'jev-quota-test-'));
 try {
  const hold = quota.nativeQuotaHold(failure, now);
  quota.saveQuotaHold(directory, failure.childRunId, hold);
  const holds = quota.readQuotaHolds(directory,now+1000);
  const status = (type, models, windows=[]) => ({
   enabled:true,status:'ready',auth:{type,status:'authenticated'},
   models:models.map(slug=>({slug})),usageLimits:{windows},
  });
  const statuses = {
   opencode:status(undefined,['opencode-go/kimi-k3.1-pro','opencode-go/beam-free']),
   antigravity:status('oauth-personal',['claude-opus-4-6-thinking','gemini-3.8-flash'],[
    {id:'3p-weekly',usedPercent:100,resetsAt:'2026-11-26T05:00:00Z'},
   ]),
   cursor:status('browser',['composer-2.5']),
  };
  const capabilities = {providers:Object.keys(statuses).map(providerInstanceId=>({
   providerInstanceId,canRunChildTask:true,models:[],
  }))};
  const models = candidateTargets({profiles:[]},capabilities,statuses,{now:now+1000,quotaHolds:holds})
   .map(p=>p.model);
  assert.deepEqual(models,['opencode-go/beam-free','gemini-3.8-flash','composer-2.5']);
  assert.deepEqual(quota.readQuotaHolds(directory,now+5*60*60*1000),{});
  assert.equal(quota.nativeQuotaHold({...failure,status:'completed'},now),undefined);
  assert.equal(quota.nativeQuotaHold({...failure,summary:'Command failed: quota file was missing.'},now),undefined);
 } finally {
  fs.rmSync(directory,{recursive:true,force:true});
 }
});

test('quota replay requires complete evidence and each exhausted bucket is skipped once per request', async () => {
 const state = {routeHistory:[{runId:'run',task:'Work on the fixture',quotaSkippedBuckets:[],
  provider:'opencode',model:'opencode-go/kimi-k3.1-pro'}],pending:[]};
 const item = type => ({runId:'run',type});
 const timeline = {thread:{threadId:'child',latestRunId:'run',activeRunId:null,pendingRequestCount:0},
  hasMore:false,items:[item('user_message'),item('handoff'),item('error')]};
 const io = {call:async()=>timeline,pool:async()=>({candidates:[{provider:'cursor',model:'composer-2.5'}]})};
 assert.equal(await quota.queueQuotaRetry(state,failure,io),true);
 assert.equal(state.pending[0].task,'Work on the fixture');
 assert.deepEqual(state.pending[0].quotaSkippedBuckets,['opencode:go-included']);
 assert.equal(await quota.queueQuotaRetry(state,failure,io),false);
 const fresh = () => ({...state,pending:[],quotaRetryRunId:undefined});
 timeline.items.push(item('command_execution'));
 assert.equal(await quota.queueQuotaRetry(fresh(),failure,io),false);
 timeline.items.pop();
 timeline.hasMore = true;
 assert.equal(await quota.queueQuotaRetry(fresh(),failure,io),false);
 const paged = {...io,call:async(_name,args)=>args.afterPosition===99
  ? {...timeline,hasMore:false,items:[item('error')]}
  : {...timeline,nextPosition:99,items:[{runId:'older-run',type:'command_execution'}]}};
 assert.equal(await quota.queueQuotaRetry(fresh(),failure,paged),true);
 timeline.hasMore = false;
 assert.equal(await quota.queueQuotaRetry({pending:[],routeHistory:[{
  ...state.routeHistory[0],quotaSkippedBuckets:['opencode:go-included'],
 }]},failure,io),false);
 const next = {pending:[],routeHistory:[{
  ...state.routeHistory[0],provider:'antigravity',model:'claude-opus-4-6-thinking',
  quotaSkippedBuckets:state.pending[0].quotaSkippedBuckets,
 }]};
 const antigravityFailure = {...failure,providerInstanceId:'antigravity',model:'claude-opus-4-6-thinking',
  summary:'You have reached your Antigravity quota for this period.'};
 assert.equal(await quota.queueQuotaRetry(next,antigravityFailure,io),true);
 assert.deepEqual(next.pending[0].quotaSkippedBuckets,['opencode:go-included','antigravity:3p']);
 const returned = [{provider:'opencode',model:'opencode-go/kimi-k3.1-pro'},{provider:'cursor',model:'composer-2.5'}];
 assert.deepEqual(quota.excludeQuotaBuckets(returned,next.pending[0].quotaSkippedBuckets),[returned[1]]);
});
