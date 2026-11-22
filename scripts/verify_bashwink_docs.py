#!/usr/bin/env python3
"""Read-only completeness and task-consistency verification for Bashwink docs.
Run from the repository root: python3 scripts/verify_bashwink_docs.py
"""
from pathlib import Path
import csv
import re
import sys
import json
import hashlib
from collections import Counter

repo = Path(__file__).resolve().parents[1]
docs = repo / 'docs' / 'bashwink'
REQUIRED = [
    'README.md','AGENT_WORKFLOW.md','BASHWINK_MASTER_AGENT_PROMPT.md','AUDIT_REPORT.md','PACKAGE_MANIFEST.json',
    'BASHWINK_PRODUCT_REQUIREMENTS.md','IMPLEMENTATION_BACKLOG.md',
    'ADR-001-FOUNDATION-AND-FORK.md','BASHWINK_FULL_PLAN.md',
    'COMPETITIVE_GAP_RESEARCH.md','BASHWINK_V2_PRD_ADDENDUM.md',
    'BASHWINK_V2_FEATURE_BACKLOG.md','BASHWINK_V2_INTEGRATED_PLAN.md',
    'EXPERIMENTS_AND_EVALUATIONS.md','BASHWINK_PHASE_BY_PHASE_TASK_PLAN.md',
    'BASHWINK_TASKS_90.csv','PHASE_GATE_CHECKLIST.md',
    'IMPLEMENTATION_STATUS.md','DECISIONS.md','TEST_EVIDENCE.md',
    'NEXT_STEPS.md','UPSTREAM_BASELINE.md',
    'PHASE-00-FOUNDATION.md','PHASE-01-CLI-CORE.md',
    'PHASE-02-PROOF-SECURITY.md','PHASE-03-MEMORY-VERIFIER.md',
    'PHASE-04-SANDBOX-AGENTS.md','PHASE-05-EVALUATION.md',
    'PHASE-06-RELEASE.md','PHASE-07-FUTURE.md',
    'reports/BASHWINK_FULL_PLAN.docx',
    'reports/BASHWINK_V2_RESEARCH_AND_ROADMAP.docx',
    'reports/BASHWINK_PHASE_BY_PHASE_TASK_PLAN.docx',
    'reports/BASHWINK_V2_REPORT_READABLE.md',
]
errors=[]
def check(cond, message):
    if not cond: errors.append(message)

check((repo/'AGENTS.md').is_file(),'Missing root AGENTS.md')
for path in REQUIRED:
    check((docs/path).is_file(),f'Missing docs/bashwink/{path}')
if (docs/'BASHWINK_TASKS_90.csv').exists():
    with (docs/'BASHWINK_TASKS_90.csv').open(newline='',encoding='utf-8-sig') as f:
        rows=list(csv.DictReader(f))
    ids=[r['ID'] for r in rows]
    taskmap={r['ID']:r for r in rows}
    expected={f'BW-{i:03d}' for i in range(1,91)}
    check(len(rows)==90, f'Expected 90 tasks, found {len(rows)}')
    check(len(set(ids))==len(ids), 'Duplicate task ID')
    check(set(ids)==expected, f'IDs missing/unexpected: {sorted(set(ids)^expected)}')
    check(Counter(r['Source'] for r in rows)=={'v1':54,'v2':36},'Unexpected v1/v2 task totals')
    phasecounts=Counter(r['Phase'] for r in rows)
    check(phasecounts == {'P0':9,'P1':10,'P2':15,'P3':19,'P4':13,'P5':8,'P6':9,'P7':7},f'Unexpected phase task counts: {phasecounts}')
    check(all(r['Status'] in ('Not started','In progress','Blocked','Done','Deferred') for r in rows),'Unexpected task status values')
    graph={}
    for r in rows:
        tid=r['ID']; dep=set(re.findall(r'BW-\d{3}',r['Dependencies'])); graph[tid]=dep
        for d in dep:
            check(d in taskmap, f'{tid} missing dependency {d}')
            if d in taskmap:
                check(int(taskmap[d]['Phase'][1:]) <= int(r['Phase'][1:]), f'{tid} depends on later phase task {d}')
            check(d!=tid, f'{tid} self dependency')
    visit={}
    def dfs(node):
        if visit.get(node)==1:
            errors.append(f'Dependency cycle at {node}')
            return
        if visit.get(node)==2: return
        visit[node]=1
        for d in graph[node]:
            if d in graph: dfs(d)
        visit[node]=2
    for task in graph: dfs(task)
    for p,file in enumerate([
        'PHASE-00-FOUNDATION.md','PHASE-01-CLI-CORE.md',
        'PHASE-02-PROOF-SECURITY.md','PHASE-03-MEMORY-VERIFIER.md',
        'PHASE-04-SANDBOX-AGENTS.md','PHASE-05-EVALUATION.md',
        'PHASE-06-RELEASE.md','PHASE-07-FUTURE.md']):
        if not (docs/file).is_file(): continue
        contents=(docs/file).read_text(encoding='utf-8')
        assigned={r['ID'] for r in rows if r['Phase']==f'P{p}'}
        check(assigned.issubset(set(re.findall(r'BW-\d{3}',contents))),f'{file} missing assigned IDs: {assigned-set(re.findall(r"BW-\d{3}",contents))}')
    print('Phase tasks:',', '.join(f'{k}={phasecounts[k]}' for k in sorted(phasecounts)))
if '--check-manifest' in sys.argv and (docs/'PACKAGE_MANIFEST.json').exists():
    manifest=json.loads((docs/'PACKAGE_MANIFEST.json').read_text(encoding='utf-8'))
    for rel,info in manifest['files'].items():
        p=docs/rel
        if not p.is_file():
            errors.append(f'Hash check cannot find {rel}')
        elif hashlib.sha256(p.read_bytes()).hexdigest()!=info['sha256']:
            errors.append(f'Hash mismatch since bundle creation: {rel}')
print('Audit:', 'PASS' if not errors else 'FAIL')
for error in errors: print('ERROR:',error)
sys.exit(1 if errors else 0)
