"""Classify an admitted native T3 target with the existing real TypeSafe client."""
import json,sys
from jev_client import JevClient

NATIVE_WORKERS = {
    'codex': 'codex', 'claudeAgent': 'claude', 'cursor': 'codex',
    'opencode': 'opencode', 'antigravity': 'codex', 'grok': 'grok',
}

def classify(value,client=None):
    task=value['task']; candidates=value['candidates']
    if not isinstance(task,str) or not task.strip() or len(task.encode())>65536:
        raise ValueError('Invalid task')
    if not isinstance(candidates,list) or not 1<=len(candidates)<=255:
        raise ValueError('Invalid target pool')
    profiles={}
    for p in candidates:
        if p['provider'] not in NATIVE_WORKERS:
            raise ValueError('Unsupported native provider')
        if p['provider']=='opencode' and not p['model'].startswith('opencode-go/'):
            raise ValueError('Only OpenCode Go is authorized')
        if p['id'] in profiles:
            raise ValueError('Duplicate native target')
        if p['model'] in ('auto', 'default', 'auto-smart'):
            raise ValueError('A concrete model ID is required')
        # The worker family here is a JevClient validation field. Dispatch uses
        # the native T3 provider and exact model in the selected profile.
        worker=NATIVE_WORKERS[p['provider']]
        description = (f"{p['description']} Native T3 provider: {p['provider']}. "
                       "Native project tools and installed skills, subject to inherited permissions.")
        if p.get('effort'):
            description += ' Available reasoning settings: ' + json.dumps(p['effort']['values']) + '.'
        profiles[p['id']] = {'worker':worker,'model':p['model'],'description':description}
    result = (client or JevClient(timeout=35)).route_task(
        task, list(dict.fromkeys(p['worker'] for p in profiles.values())), profiles=profiles,
        choose_effort=any(p.get('effort') for p in candidates),
    )
    chosen=next(p for p in candidates if p['id']==result['profile'])
    route = {'classifier':result['model'],'confidence':result['confidence'],
             'probabilities':result['probabilities'],'usage':result['usage'],'profile':chosen}
    if 'effort' in result:
        route['effort'] = result['effort']
    return route

if __name__=='__main__':
    try:
        value=json.loads(sys.stdin.read(131073))
        print(json.dumps(classify(value),separators=(',',':')))
    except Exception as e:
        print(json.dumps({'error':str(e)[:500]}));sys.exit(1)
