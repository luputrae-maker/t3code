import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const minute = 60_000;

export function exhaustedWindow(window, now) {
 return window.usedPercent >= 100 && (!window.resetsAt || Date.parse(window.resetsAt) > now);
}

function antigravityBuckets(model) {
 if (model.startsWith('gemini-') && model.includes('argon')) return ['gemini-argon'];
 if (model.startsWith('gemini-')) return ['gemini'];
 if (model.startsWith('claude-')) return ['3p','claude'];
 if (model.startsWith('gpt-')) return ['3p','gpt'];
 return [];
}

function isOpenCodeFree(model) {
 return model.endsWith('-free');
}

function bucketFor(provider, model) {
 if (provider === 'antigravity') {
  return `antigravity:${antigravityBuckets(model)[0] ?? model}`;
 }
 if (provider === 'opencode') {
  return isOpenCodeFree(model) ? `opencode:${model}` : 'opencode:go-included';
 }
 return provider;
}

export function modelQuotaAvailable(provider,model,windows,holds,now) {
 if (holds[bucketFor(provider,model)] > now) return false;
 if (provider !== 'antigravity') return true;
 const buckets = antigravityBuckets(model);
 return !windows.some(window => {
  // Argon has a separate quota from other Gemini models.
  const id = window.id ?? '';
  const bucket = id.startsWith('gemini-argon-') ? 'gemini-argon' : id.split('-')[0];
  return buckets.includes(bucket) && exhaustedWindow(window,now);
 });
}

export function nativeQuotaHold(result,observedAt) {
 if (result.status !== 'failed' || result.workState !== 'result_available' ||
     result.latestTerminalRunId !== result.childRunId || !result.childRunId ||
     typeof result.model !== 'string' || !Number.isFinite(observedAt)) return;
 const message = result.summary?.trim() ?? '';
 const provider = result.providerInstanceId;
 let duration;
 if (provider === 'opencode' && /^OpenCode Go 5[- ]hour usage limit reached\./i.test(message)) {
  duration = 300 * minute;
 } else if (provider === 'antigravity' && /^You have reached your Antigravity quota for this period\.$/i.test(message)) {
  duration = 30 * minute;
 } else if (provider === 'codex' && /^You['’]ve hit your usage limit\./i.test(message)) {
  duration = 15 * minute;
 } else if (provider === 'claudeAgent' && /^Claude API rate limit reached\. Try again later\.$/i.test(message)) {
  duration = 15 * minute;
 }
 if (duration) return {bucket:bucketFor(provider,result.model),until:observedAt+duration};
}

export function saveQuotaHold(directory,runId,hold) {
 if (!hold) return;
 fs.mkdirSync(directory,{recursive:true,mode:0o700});
 const name = crypto.createHash('sha256').update(runId).digest('hex');
 const target = path.join(directory,`${name}.json`);
 const temporary = path.join(directory,crypto.randomUUID());
 fs.writeFileSync(temporary,JSON.stringify(hold),{mode:0o600,flag:'wx'});
 fs.renameSync(temporary,target);
}

export function readQuotaHolds(directory,now=Date.now()) {
 if (!fs.existsSync(directory)) return {};
 const holds = new Map();
 for (const entry of fs.readdirSync(directory,{withFileTypes:true})) {
  if (!entry.isFile() || !/^[0-9a-f]{64}\.json$/.test(entry.name)) continue;
  const {bucket,until} = JSON.parse(fs.readFileSync(path.join(directory,entry.name),'utf8'));
  if (typeof bucket === 'string' && Number.isFinite(until) && until > now) {
   holds.set(bucket,Math.max(until,holds.get(bucket)??0));
  }
 }
 return Object.fromEntries(holds);
}

export function excludeQuotaBuckets(candidates,buckets) {
 return candidates.filter(profile=>!buckets.includes(bucketFor(profile.provider,profile.model)));
}

async function failedBeforeWork(result,io) {
 let afterPosition;
 let sawError=false;
 for(let page=0;page<5;page++){
  const {thread,hasMore,items,nextPosition}=await io.call('t3_thread_read',{
   threadId:result.childThreadId,view:'activity',limit:100,runLimit:1,maxCharsPerItem:1000,
   ...(afterPosition===undefined?{}:{afterPosition}),
  });
  if(thread.threadId!==result.childThreadId || thread.latestRunId!==result.childRunId ||
     thread.activeRunId || thread.pendingRequestCount!==0) return false;
  for(const item of items){
   if(item.runId!==result.childRunId) continue;
   if(!['user_message','handoff','error'].includes(item.type)) return false;
   sawError ||= item.type==='error';
  }
  if(hasMore===false) return sawError;
  if(!Number.isInteger(nextPosition) || nextPosition<=(afterPosition??-1)) return false;
  afterPosition=nextPosition;
 }
 return false;
}

export async function queueQuotaRetry(state,result,io) {
 const last = state.routeHistory?.at(-1);
 if (state.cancelled || state.uncertain || state.pending?.length ||
     !Array.isArray(last?.quotaSkippedBuckets) || !last.task?.trim() || last.runId !== result.childRunId ||
     result.latestTerminalRunId !== last.runId || state.quotaRetryRunId === last.runId ||
     result.hasPendingChildRuns || result.hasPendingQuestion || result.pendingApproval) return false;

 // Replay only when T3 shows the exact failed run's complete activity with
 // no provider output, tool activity, pending approvals, or new work.
 if (!await failedBeforeWork(result,io)) return false;
 const failedBucket = bucketFor(last.provider,last.model);
 if (last.quotaSkippedBuckets.includes(failedBucket)) return false;
 const quotaSkippedBuckets = [...last.quotaSkippedBuckets,failedBucket];
 const {candidates} = await io.pool();
 if (state.cancelled || state.pending?.length || !excludeQuotaBuckets(candidates,quotaSkippedBuckets).length) return false;
 state.quotaRetryRunId = last.runId;
 state.pending = [{id:crypto.randomUUID(),task:last.task,queuedAt:new Date().toISOString(),quotaSkippedBuckets}];
 return true;
}
