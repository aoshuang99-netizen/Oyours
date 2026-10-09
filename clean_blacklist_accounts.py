import json, os

DATA = os.path.join(os.path.dirname(__file__), 'data')
BLP = ('test_', 'sys_', 'bootstrap')
BLPF = ('system', 'unknown', 'gmail')
PLAT_MAP = {'x': 'twitter', 'twitter': 'twitter'}

def is_black(rec):
    if not isinstance(rec, dict):
        return True
    aid = rec.get('id')
    if not isinstance(aid, str):
        return True
    if aid.startswith(BLP):
        return True
    if rec.get('') in BLPF:
        return True
    return False

# ── 1. 清理 .json ──
ap = os.path.join(DATA, '.json')
accts = json.load(open(ap))
real_by_plat = {}
clean_accts = []
for a in accts:
    if is_black(a):
        continue
    clean_accts.append(a)
    p = a.get('')
    real_by_plat.setdefault(p, []).append(a.get('id'))

removed = len(accts) - len(clean_accts)
json.dump(clean_accts, open(ap, 'w'), ensure_ascii=False, indent=2)
print(f'[.json] 原始 {len(accts)} → 清理后 {len(clean_accts)} (删除 {removed} 个黑名单账户)')
print('[.json] 真实账户按平台:', {k: len(v) for k, v in real_by_plat.items()})

# 确保每个平台都有真实账户可用 (含 x->twitter 映射)
def pick(plat):
    lst = real_by_plat.get(plat) or real_by_plat.get(PLAT_MAP.get(plat, plat))
    if not lst:
        # 退一步: 任意真实账户
        for v in real_by_plat.values():
            if v:
                return v[0]
    return lst[0] if lst else None

# ── 2. 清理 publish.json ──
pp = os.path.join(DATA, 'publish.json')
pubs = json.load(open(pp))
rebound = 0
for p in pubs:
    if not isinstance(p, dict):
        continue
    aid = p.get('account_id')
    plat = p.get('')
    if isinstance(aid, str) and aid.startswith(BLP):
        new_id = pick(plat)
        if new_id:
            p['account_id'] = new_id
            rebound += 1
json.dump(pubs, open(pp, 'w'), ensure_ascii=False, indent=2)
print(f'[publish.json] 重新绑定 {rebound} 条黑名单账户 → 同平台真实账户')

# ── 3. 清理其他数据文件中仍引用黑名单账户的统计一致性 (content / analytics / nurture_logs / social_logs) ──
for fn in ['content.json']:
    fp = os.path.join(DATA, fn)
    if not os.path.exists(fp):
        continue
    arr = json.load(open(fp))
    cnt = 0
    for r in arr:
        if not isinstance(r, dict):
            continue
        aid = r.get('account_id')
        if isinstance(aid, str) and aid.startswith(BLP):
            new_id = pick(r.get(''))
            if new_id:
                r['account_id'] = new_id
                cnt += 1
    json.dump(arr, open(fp, 'w'), ensure_ascii=False, indent=2)
    print(f'[{fn}] 重新绑定 {cnt} 条黑名单账户')

print('✅ 清理完成')
