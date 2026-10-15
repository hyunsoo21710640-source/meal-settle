/* =====================================================================
   식대 정산 앱
   - 데이터는 브라우저 localStorage에 저장 (서버 없음)
   - 구조
     state.members : [{ id, name, active }]  ← id 'me' 는 결제자(나)
     state.meals   : [{ id, date, type, place, split, participants,
                        items, common, total, shares, paid, memo, createdAt, voucher? }]
        · shares : { 팀원id: 부담금액 }  ← 상품권 할인이 있으면 할인 후 금액
        · base   : 개별 금액의 기본 금액(빈 칸에 들어간 값) / fixed: 1/N에서 따로 정한 { 팀원id: 금액 }
        · menus  : { 팀원id: 메뉴 } (개별 금액·1/N 모두, 빈 메뉴는 저장 안 함) / baseMenu: 기본 메뉴
        · voucher: { rate, gross, grossShares }  ← 지역상품권 할인 기록(할인율, 할인 전 총액·부담액)
        · paid   : { 팀원id: 입금확인 시각(timestamp) }  ← 없으면 미입금
   ===================================================================== */

const STORAGE_KEY = 'mealSettle.v1';

function defaultState() {
  return {
    version: 1,
    members: [{ id: 'me', name: '나', active: true }],
    account: '',
    rounding: 'none',          // none | up100 | down100
    voucherRate: 10,           // 지역상품권 할인율(%)
    meals: [],
    lastParticipants: ['me'],
    includeDetail: false,
  };
}

let state = loadState();
ensureMenuBook();

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return Object.assign(defaultState(), JSON.parse(raw));
  } catch (e) { /* 저장소 접근 불가 시 빈 상태로 시작 */ }
  return defaultState();
}
// 저장된 메뉴가 없던 예전 데이터는 지난 기록의 메뉴로 한 번 채움 (오래된 것부터 → 최근 가격이 남음)
function ensureMenuBook() {
  if (state.menuBook) return;
  state.menuBook = {};
  [...state.meals].sort((a, b) => a.date.localeCompare(b.date) || a.createdAt - b.createdAt).forEach(rememberMenus);
}
function saveState() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  catch (e) { toast('저장에 실패했어요. 브라우저 설정을 확인해 주세요.'); }
}

/* ===================== 유틸 ===================== */
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const fmt = n => (Math.round(n) || 0).toLocaleString('ko-KR');
const won = n => fmt(n) + '원';
const toNum = s => parseInt(String(s).replace(/[^0-9]/g, ''), 10) || 0;
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const sum = obj => Object.values(obj).reduce((a, b) => a + (b || 0), 0);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DOW = ['일', '월', '화', '수', '목', '금', '토'];

function dateStr(d) {
  const z = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}
const todayStr = () => dateStr(new Date());
function parseDate(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
function fmtDate(s) { const d = parseDate(s); return `${d.getMonth() + 1}/${d.getDate()}(${DOW[d.getDay()]})`; }
function fmtDateLong(s) { const d = parseDate(s); return `${d.getMonth() + 1}월 ${d.getDate()}일 (${DOW[d.getDay()]})`; }
function fmtTime(ts) { const d = new Date(ts); return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }
function mondayOf(s) { const d = parseDate(s); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return dateStr(d); }

const member = id => state.members.find(m => m.id === id);
const nameOf = id => (member(id) || { name: '(알 수 없음)' }).name;
const label = id => {
  if (id !== 'me') return nameOf(id);
  const n = nameOf('me');
  return n === '나' ? '나' : `${n}(나)`;
};
// 참석자를 팀원 목록 순서대로 정렬
const ordered = ids => state.members.map(m => m.id).filter(id => ids.includes(id));

function setSeg(sel, value) {
  $$(sel + ' button').forEach(b => b.classList.toggle('on', b.dataset.v === value));
}

let toastTimer;
function toast(msg, actionLabel, actionFn) {
  const el = $('#toast');
  el.innerHTML = `<span>${esc(msg)}</span>` + (actionLabel ? `<button>${esc(actionLabel)}</button>` : '');
  el.hidden = false;
  if (actionLabel) el.querySelector('button').onclick = () => { el.hidden = true; actionFn(); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), actionLabel ? 5000 : 2200);
}

/* ===================== 금액 계산 ===================== */
// 총액을 참석자 수로 나눔. 결제자(나)가 있으면 끝전은 내 몫에서 조정
function splitEven(total, ids) {
  const out = {};
  const n = ids.length;
  if (!n || !total) { ids.forEach(id => (out[id] = 0)); return out; }
  const others = ids.filter(id => id !== 'me');
  const per = total / n;

  if (ids.includes('me') && others.length) {
    let o = Math.floor(per);
    if (state.rounding === 'up100') o = Math.ceil(per / 100) * 100;
    if (state.rounding === 'down100') o = Math.floor(per / 100) * 100;
    if (total - o * others.length < 0) o = Math.floor(per); // 금액이 너무 작을 때 안전장치
    others.forEach(id => (out[id] = o));
    out.me = total - o * others.length;
  } else {
    // 내가 없으면 1원 단위로 나누고 남는 원은 앞사람부터 1원씩
    const base = Math.floor(total / n);
    let rem = total - base * n;
    ids.forEach(id => { out[id] = base + (rem > 0 ? 1 : 0); if (rem > 0) rem--; });
  }
  return out;
}

// 개별 금액: 직접 넣은 금액이 없으면 기본 금액
const itemOf = (f, id) => f.items[id] || f.base || 0;
// 개별 금액의 메뉴: 직접 쓴 메뉴 → 기본 메뉴
const menuIn = (f, id) => (f.menus[id] || f.baseMenu || '').trim();
// 저장된 기록의 메뉴. 없으면 식당 이름으로 대체
const menuOf = (m, id) => (m.menus && m.menus[id]) || m.place || m.type;
// 1/N에서 금액을 따로 정한 참석자
const fixedIds = f => ordered(f.participants).filter(id => f.fixed && id in f.fixed);
const fixedSum = f => fixedIds(f).reduce((a, id) => a + (f.fixed[id] || 0), 0);

function calcShares(f) {
  const ids = ordered(f.participants);
  if (f.split === 'equal') {
    const fx = fixedIds(f);
    const out = splitEven(Math.max(0, f.total - fixedSum(f)), ids.filter(id => !fx.includes(id)));
    fx.forEach(id => (out[id] = f.fixed[id] || 0));
    return out;
  }
  const shares = {};
  ids.forEach(id => (shares[id] = itemOf(f, id)));
  if (f.common > 0) {
    const add = splitEven(f.common, ids);
    ids.forEach(id => (shares[id] += add[id]));
  }
  return shares;
}

// 지역상품권 할인: 각자 몫을 rate%만큼 줄임. 끝전은 내 몫에서 조정(내가 없으면 앞사람부터 1원씩)
function applyVoucher(gross, ids, rate) {
  const netTotal = Math.round(sum(gross) * (100 - rate) / 100);
  const out = {};
  ids.forEach(id => (out[id] = Math.floor((gross[id] || 0) * (100 - rate) / 100)));
  let rem = netTotal - sum(out);
  if (ids.includes('me')) out.me += rem;
  else ids.forEach(id => { if (rem > 0) { out[id]++; rem--; } });
  return out;
}

// 저장·미리보기에 쓰는 최종 부담액. 상품권이면 할인 전 금액도 함께 돌려줌
function finalShares(f) {
  const shares = calcShares(f);
  if (!f.voucher) return { shares, voucher: null };
  const rate = f.voucherRate ?? state.voucherRate;
  return { shares: applyVoucher(shares, ordered(f.participants), rate), voucher: { rate, gross: sum(shares), grossShares: shares } };
}
// 상품권으로 줄어든 금액
const voucherSaved = (m, id) => (m.voucher ? (m.voucher.grossShares[id] || 0) - (m.shares[id] || 0) : 0);

const isPaid = (m, id) => !!(m.paid && m.paid[id]);
// 내 몫을 제외한 모든 사람이 입금했으면 정산 완료
const isDone = m => m.participants.every(id => id === 'me' || !(m.shares[id] > 0) || isPaid(m, id));

// 사람별 미입금 금액
function outstanding() {
  const per = {};
  const meals = [...state.meals].sort((a, b) => a.date.localeCompare(b.date) || a.createdAt - b.createdAt);
  meals.forEach(m => m.participants.forEach(id => {
    const amt = m.shares[id] || 0;
    if (id === 'me' || amt <= 0 || isPaid(m, id)) return;
    (per[id] ||= { amt: 0, items: [] });
    per[id].amt += amt;
    per[id].items.push({ m, amt });
  }));
  return per;
}

/* ===================== 탭 전환 ===================== */
const TAB_TITLES = { home: '이번 주 식대', record: '오늘 뭐 먹었어요?', list: '먹은 기록', settle: '정산', settings: '설정' };
let currentTab = 'record';

function showTab(tab) {
  currentTab = tab;
  $('#toast').hidden = true;
  $$('.tab').forEach(s => (s.hidden = s.id !== 'tab-' + tab));
  $$('.navbtn').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  $('#pageTitle').textContent = TAB_TITLES[tab];
  $('#saveBar').hidden = tab !== 'record';
  ({ home: renderHome, record: renderRecord, list: renderList, settle: renderSettle, settings: renderSettings })[tab]();
  renderTop();
  window.scrollTo(0, 0);
}
$$('.navbtn').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));

function renderTop() {
  const total = sum(Object.fromEntries(Object.entries(outstanding()).map(([k, v]) => [k, v.amt])));
  const pill = $('#owePill');
  pill.hidden = !total || currentTab === 'settle' || currentTab === 'home';
  pill.textContent = `받을 돈 ${won(total)}`;
}
$('#owePill').addEventListener('click', () => showTab('settle'));

/* ===================== ⓪ 홈 탭 (대시보드) =====================
   - 점심 평균은 회식을 빼고 계산, 회식은 따로 표시
   - 금액은 실제 결제액(meal.total, 상품권 할인 반영)
   - 그래프 카드 3장(요일별 비교 / 8주 분석 / 달력)을 탭·밀기로 넘김 */
const addDays = (s, n) => { const d = parseDate(s); d.setDate(d.getDate() + n); return dateStr(d); };
const md = s => { const d = parseDate(s); return `${d.getMonth() + 1}/${d.getDate()}`; };
const man = n => `${(n / 10000).toFixed(1)}만`;
const ICONS = {
  record: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  settle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="6" width="20" height="13" rx="2"/><path d="M2 10h20M6 15h4"/></svg>',
  list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>',
};
const DINNER_C = '#2563b0';
const PIE_COLORS = ['#c9450e', '#159a6b', '#8f5bd6', '#2563b0', '#b7a38d'];   // 색약 검사 통과 4색 + 기타 회색

const home = { who: 'team', cmp: 'last', panel: 0, week: 7, pie: 'place', slice: null, day: null, month: null };
// 금액 기준: 팀 전체(실제 결제액) 또는 내 몫(내가 참석한 끼니의 내 부담액)
const isMe = () => home.who === 'me';
const amt = m => (isMe() ? m.shares.me || 0 : m.total);
const homeMeals = () => (isMe() ? state.meals.filter(m => m.participants.includes('me')) : state.meals);
const perLabel = () => (isMe() ? '한 끼 평균' : '1인 평균');

// 한 주(월~일) 통계. 점심만 평균에 넣음
function weekStats(mon) {
  const end = addDays(mon, 6);
  const meals = homeMeals().filter(m => m.date >= mon && m.date <= end);
  const lunch = meals.filter(m => m.type !== '회식');
  const total = lunch.reduce((a, m) => a + amt(m), 0);
  const days = new Set(lunch.map(m => m.date)).size;
  const people = isMe() ? lunch.length : lunch.reduce((a, m) => a + m.participants.length, 0);
  return {
    total, days,
    dailyAvg: days ? total / days : 0, perAvg: people ? total / people : 0,
    byDay: [0, 1, 2, 3, 4].map(i => lunch.filter(m => m.date === addDays(mon, i)).reduce((a, m) => a + amt(m), 0)),
    dinnerDays: [0, 1, 2, 3, 4].map(i => meals.some(m => m.type === '회식' && m.date === addDays(mon, i))),
    dinnerTotal: meals.filter(m => m.type === '회식').reduce((a, m) => a + amt(m), 0),
  };
}
// 비교 기준: 지난주, 또는 기록이 있는 최근 4주 평균
function baseStats(mon) {
  if (home.cmp === 'last') return { label: '지난주', ...weekStats(addDays(mon, -7)) };
  const ws = [1, 2, 3, 4].map(k => weekStats(addDays(mon, -7 * k))).filter(w => w.total);
  const avg = f => (ws.length ? ws.reduce((a, w) => a + f(w), 0) / ws.length : 0);
  return { label: '4주 평균', dailyAvg: avg(w => w.dailyAvg), perAvg: avg(w => w.perAvg), byDay: [0, 1, 2, 3, 4].map(i => avg(w => w.byDay[i])) };
}
const chg = (now, base) => {
  if (!base || !now) return '';
  const p = (now - base) / base * 100;
  return `<span class="chg ${p > 0 ? 'up' : p < 0 ? 'down' : ''}">${p > 0 ? '▲' : p < 0 ? '▼' : ''} ${Math.abs(p).toFixed(1)}%</span>`;
};

function renderHome() {
  const mon = mondayOf(todayStr());
  const now = weekStats(mon), base = baseStats(mon);
  const per = outstanding(), ids = personIds(per);
  const owe = ids.reduce((a, id) => a + per[id].amt, 0);
  const oweMeals = new Set(ids.flatMap(id => per[id].items.map(x => x.m.id))).size;
  let html = '';

  // 받을 돈 + 바로가기
  html += owe
    ? `<button class="card hero home-hero" data-go="settle"><span class="sub">아직 받을 돈</span><span class="big">${won(owe)}</span><span class="sub">미입금 ${ids.length}명 · 기록 ${oweMeals}건</span></button>`
    : `<div class="card"><div class="sub">아직 받을 돈</div><div class="big">0원</div><div class="sub">모두 정산됐어요</div></div>`;
  html += `
    <nav class="shortcuts" aria-label="바로가기">
      <button data-go="record">${ICONS.record}기록하기</button>
      <button data-go="settle">${ICONS.settle}정산하기${ids.length ? ` · ${ids.length}명` : ''}</button>
      <button data-go="list">${ICONS.list}내역 보기</button>
    </nav>`;

  // 금액 기준 + 비교 기준 + 점심 하루 평균
  html += `
    <div class="seg home-seg" role="group" aria-label="금액 기준">
      <button data-who="team" class="${isMe() ? '' : 'on'}">팀 전체</button>
      <button data-who="me" class="${isMe() ? 'on' : ''}">내 몫</button>
    </div>
    <div class="seg home-seg" role="group" aria-label="비교 기준">
      <button data-cmp="last" class="${home.cmp === 'last' ? 'on' : ''}">지난주와 비교</button>
      <button data-cmp="avg" class="${home.cmp === 'avg' ? 'on' : ''}">최근 4주 평균과 비교</button>
    </div>`;
  if (now.total) {
    const diff = now.dailyAvg - base.dailyAvg;
    html += `
      <div class="card avg-card">
        <div class="label">${isMe() ? '내 ' : ''}점심 하루 평균 (회식 제외) · ${md(mon)}~${md(addDays(mon, 6))}</div>
        <div class="avg-main"><span class="avg-num">${won(Math.round(now.dailyAvg))}</span>${chg(now.dailyAvg, base.dailyAvg)}</div>
        <div class="sub">${base.dailyAvg ? `${base.label} ${won(Math.round(base.dailyAvg))}보다 ${won(Math.round(Math.abs(diff)))} ${diff >= 0 ? '더' : '덜'} 썼어요` : `비교할 ${base.label} 점심 기록이 없어요`}</div>
        <div class="avg-sub"><span>${perLabel()} <b>${won(Math.round(now.perAvg))}</b> ${chg(now.perAvg, base.perAvg)}</span><span>점심 <b>${now.days}일</b></span></div>
      </div>`;
  } else {
    html += `<div class="card avg-card"><div class="label">${isMe() ? '내 ' : ''}점심 하루 평균 (회식 제외)</div><div class="sub">이번 주 점심 기록이 아직 없어요. <button class="linkbtn" data-go="record">기록하기 →</button></div></div>`;
  }

  // 그래프 카드
  const tabs = ['요일별 비교', '8주 분석', `${monthLabel()} 달력`];
  html += `
    <section class="card carousel" aria-label="그래프">
      <div class="ctabs" role="tablist">${tabs.map((t, i) => `<button role="tab" aria-selected="${i === home.panel}" data-panel="${i}" class="${i === home.panel ? 'on' : ''}">${t}</button>`).join('')}</div>
      <div class="cview"><div class="ctrack" style="transform: translateX(${-100 * home.panel}%)">
        <div class="cpanel ${home.panel === 0 ? 'on' : ''}" aria-hidden="${home.panel !== 0}">${panelCompare(now, base, mon)}</div>
        <div class="cpanel ${home.panel === 1 ? 'on' : ''}" aria-hidden="${home.panel !== 1}">${panelTrend(mon)}</div>
        <div class="cpanel ${home.panel === 2 ? 'on' : ''}" aria-hidden="${home.panel !== 2}">${panelCalendar()}</div>
      </div></div>
      <div class="dots" aria-hidden="true">${tabs.map((_, i) => `<span class="${i === home.panel ? 'on' : ''}"></span>`).join('')}<em>${home.panel < 2 ? '← 밀거나 탭을 눌러 다음 그래프' : '→ 밀어서 이전 그래프'}</em></div>
    </section>`;

  // 회식 카드 (평균과 따로)
  const last = weekStats(addDays(mon, -7));
  const month = todayStr().slice(0, 7);
  const mDinner = homeMeals().filter(m => m.type === '회식' && m.date.startsWith(month));
  const dMax = Math.max(now.dinnerTotal, last.dinnerTotal, 1);
  html += `
    <section class="card dinner-card">
      <div class="label"><span>회식은 따로 봐요</span><span>이번 달 ${mDinner.length}회 · ${won(mDinner.reduce((a, m) => a + amt(m), 0))}</span></div>
      <div class="dbar"><span>이번 주</span><i style="width:${now.dinnerTotal / dMax * 100}%"></i><b>${won(now.dinnerTotal)}</b></div>
      <div class="dbar"><span>지난주</span><i class="light" style="width:${last.dinnerTotal / dMax * 100}%"></i><b>${won(last.dinnerTotal)}</b></div>
    </section>`;

  // 다시 그려도 카드 높이가 이전 높이에서 부드럽게 바뀌도록 이전 높이부터 시작
  const prevH = $('#homeBody .cview')?.offsetHeight;
  $('#homeBody').innerHTML = html;
  const view = $('#homeBody .cview');
  if (view && prevH) { view.style.height = prevH + 'px'; void view.offsetHeight; }
  fitPanel();
}

// ① 요일별 비교: 이번 주 vs 비교 기준, 막대 위는 차이(천 원)
function panelCompare(now, base, mon) {
  const max = Math.max(...now.byDay, ...base.byDay, 1);
  const cols = DOW.slice(1, 6).map((dow, i) => {
    const n = now.byDay[i], b = base.byDay[i], d = Math.round((n - b) / 100) / 10;
    const future = addDays(mon, i) > todayStr();   // 아직 안 온 요일은 차이를 표시하지 않음
    const label = !future && (n || b) ? (d > 0 ? '+' : '') + d : '';
    return `<div class="bcol">
      <span class="bdelta ${d > 0 ? 'up' : d < 0 ? 'down' : ''}">${label}</span>
      <div class="bpair"><i class="now" style="height:${n / max * 130}px"></i><i class="base" style="height:${b / max * 130}px"></i></div>
      <span class="bdow">${dow}</span>${now.dinnerDays[i] ? '<span class="dtag">회식</span>' : ''}
    </div>`;
  }).join('');
  return `
    <div class="legend"><span><i class="now"></i>이번 주</span><span><i class="base"></i>${base.label}</span></div>
    <div class="bars">${cols}</div>
    <p class="hint">막대 위 숫자는 ${base.label} 대비 차이(천 원)예요. 회식은 넣지 않았어요.</p>`;
}

// ② 8주 분석: 주별 점심 1인 평균 선 + 8주 식비 구성 도넛
function panelTrend(mon) {
  const mons = [7, 6, 5, 4, 3, 2, 1, 0].map(k => addDays(mon, -7 * k));
  const ws = mons.map(weekStats);
  const vals = ws.map(w => (w.total ? w.perAvg : null));
  const got = vals.filter(v => v != null);
  let line = '<p class="hint">8주 동안 점심 기록이 없어요.</p>';
  if (got.length) {
    let lo = Math.min(...got), hi = Math.max(...got);
    if (hi - lo < 1000) { lo -= 500; hi += 500; }
    const x = i => 24 + (302 / 8) * (i + 0.5), y = v => 130 - (v - lo) / (hi - lo) * 110;
    const pts = vals.map((v, i) => (v == null ? null : `${x(i).toFixed(1)},${y(v).toFixed(1)}`)).filter(Boolean).join(' ');
    const sw = home.week, sv = vals[sw];
    line = `
      <div class="readout"><b>${md(mons[sw])} 주</b><span>점심 ${isMe() ? '한 끼' : '1인'} <b>${sv == null ? '기록 없음' : won(Math.round(sv))}</b> · 회식 <b class="dc">${ws[sw].dinnerTotal ? won(ws[sw].dinnerTotal) : '없음'}</b></span></div>
      <div class="line-wrap">
        <svg viewBox="0 0 326 150" role="img" aria-label="최근 8주 점심 ${perLabel()} 추이">
          <line x1="0" y1="20" x2="326" y2="20" class="grid"/><line x1="0" y1="75" x2="326" y2="75" class="grid"/><line x1="0" y1="130" x2="326" y2="130" class="axis"/>
          <text x="0" y="14">${fmt(Math.round(hi))}</text><text x="0" y="126">${fmt(Math.round(lo))}</text>
          <line x1="${x(sw)}" y1="10" x2="${x(sw)}" y2="130" class="guide"/>
          <polyline points="${pts}" class="trend"/>
          ${vals.map((v, i) => (v == null ? '' : `<circle cx="${x(i)}" cy="${y(v)}" r="${i === sw ? 5 : 3}" class="${i === sw ? 'sel' : 'pt'}"/>`)).join('')}
        </svg>
        <div class="week-hits">${mons.map((m, i) => `<button data-week="${i}" aria-label="${md(m)} 주 상세 보기"></button>`).join('')}</div>
      </div>
      <div class="week-labels">${mons.map(m => `<span>${md(m)}</span>`).join('')}</div>`;
  }
  return `<h3 class="ptitle">주별 ${isMe() ? '내 ' : ''}점심 ${perLabel()} <span class="sub">주를 누르면 상세</span></h3>${line}${donut(mons[0], addDays(mon, 6))}`;
}

function donut(from, to) {
  const meals = homeMeals().filter(m => m.date >= from && m.date <= to);
  const lunch = meals.filter(m => m.type !== '회식');
  const top = (map, restLabel) => {
    const arr = Object.entries(map).sort((a, b) => b[1] - a[1]);
    const head = arr.slice(0, 4), rest = arr.slice(4);
    if (rest.length) head.push([restLabel(rest), rest.reduce((a, r) => a + r[1], 0)]);
    return head;
  };
  const byPlace = {}, byPerson = {};
  lunch.forEach(m => {
    const k = m.place || m.type;
    byPlace[k] = (byPlace[k] || 0) + amt(m);
    m.participants.forEach(id => (byPerson[id] = (byPerson[id] || 0) + (m.shares[id] || 0)));
  });
  const MODES = {
    place: { name: '식당별', note: `점심만 (회식 제외)${isMe() ? ' · 내 몫' : ''} · 상위 4곳 + 기타`,
      items: top(byPlace, r => `기타 (${r.slice(0, 2).map(x => x[0]).join('·')}${r.length > 2 ? ' 등' : ''})`) },
    person: { name: '사람별', note: '점심만 (회식 제외) · 각자 부담한 금액',
      items: top(byPerson, r => `그 외 ${r.length}명`).map(([k, v]) => [member(k) ? label(k) : k, v]) },
    kind: { name: '점심·회식', note: '회식이 전체 식비에서 차지하는 비중',
      items: [['점심', lunch.reduce((a, m) => a + amt(m), 0)], ['회식', meals.filter(m => m.type === '회식').reduce((a, m) => a + amt(m), 0)]].filter(x => x[1]) },
  };
  if (isMe()) delete MODES.person;   // 내 몫에서는 사람별 구성이 의미 없음
  if (!MODES[home.pie]) home.pie = 'place';
  const mode = MODES[home.pie], items = mode.items, total = items.reduce((a, x) => a + x[1], 0);
  const colors = home.pie === 'kind' ? (items.length === 2 ? ['#c9450e', DINNER_C] : [items[0]?.[0] === '회식' ? DINNER_C : '#c9450e']) : PIE_COLORS;
  const seg = `<div class="seg pie-seg" role="group" aria-label="구성 기준">${Object.entries(MODES).map(([k, v]) => `<button data-pie="${k}" class="${k === home.pie ? 'on' : ''}">${v.name}</button>`).join('')}</div>`;
  const head = `<h3 class="ptitle sep">최근 8주 식비 구성 <span class="sub">${md(from)} ~ ${md(to)}</span></h3>`;
  if (!total) return head + seg + '<p class="hint">이 기간에 기록이 없어요.</p>';

  const C = 2 * Math.PI * 66, sel = home.slice != null && home.slice < items.length ? home.slice : null;
  let cum = 0;
  const arcs = items.map(([, v], i) => {
    const f = v / total, len = Math.max(0, f * C - (items.length > 1 ? 2 : 0));
    const a = `<circle cx="90" cy="90" r="66" stroke="${colors[i]}" stroke-width="${sel === i ? 32 : 26}" stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-cum * C).toFixed(2)}" opacity="${sel == null || sel === i ? 1 : 0.3}"/>`;
    cum += f;
    return a;
  }).join('');
  const pctOf = v => `${Math.round(v / total * 1000) / 10}%`;
  // 가운데는 좁아서 만 원 단위로 줄여 씀 (정확한 금액은 아래 목록)
  const c = sel == null ? ['합계', `${man(total)}원`, ''] : [items[sel][0], `${man(items[sel][1])}원`, pctOf(items[sel][1])];
  return `${head}${seg}
    <div class="donut">
      <svg viewBox="0 0 180 180" role="img" aria-label="${mode.name} 구성: ${items.map(([k, v]) => `${k} ${pctOf(v)}`).join(', ')}">
        <circle cx="90" cy="90" r="66" stroke="#f3e6d5" stroke-width="26"/><g transform="rotate(-90 90 90)">${arcs}</g>
      </svg>
      <div class="donut-center"><span>${esc(c[0])}</span><b>${c[1]}</b><span>${c[2]}</span></div>
    </div>
    <div class="pie-list">${items.map(([k, v], i) => `
      <button data-slice="${i}" class="${sel === i ? 'on' : ''}" aria-pressed="${sel === i}">
        <i style="background:${colors[i]}"></i><span>${esc(k)}</span><span>${won(v)}</span><b>${pctOf(v)}</b>
      </button>`).join('')}</div>
    <p class="hint">${mode.note}</p>`;
}

// ③ 달력: 월~금, 칸 = 날짜 + 점심값(만 원) + 막대. 누르면 그 줄 아래에 그날 내역 카드
const monthLabel = () => `${Number((home.month || todayStr().slice(0, 7)).slice(5))}월`;
function panelCalendar() {
  const month = home.month || todayStr().slice(0, 7);
  const first = month + '-01';
  const lastDay = dateStr(new Date(Number(month.slice(0, 4)), Number(month.slice(5)), 0));
  const inMonth = homeMeals().filter(m => m.date.startsWith(month));
  const lunchOf = d => inMonth.filter(m => m.date === d && m.type !== '회식').reduce((a, m) => a + amt(m), 0);
  const max = Math.max(1, ...inMonth.filter(m => m.type !== '회식').map(m => lunchOf(m.date)));
  const weekend = inMonth.filter(m => [0, 6].includes(parseDate(m.date).getDay())).length;
  let rows = '';
  for (let mon = mondayOf(first); mon <= lastDay; mon = addDays(mon, 7)) {
    const days = [0, 1, 2, 3, 4].map(i => addDays(mon, i));
    rows += days.map(d => {
      if (!d.startsWith(month)) return '<span class="cal-cell out"></span>';
      const v = lunchOf(d), dinner = inMonth.some(m => m.date === d && m.type === '회식'), any = inMonth.some(m => m.date === d);
      return `<button class="cal-cell ${home.day === d ? 'on' : ''} ${d === todayStr() ? 'today' : ''}" data-day="${d}" ${any ? '' : 'disabled'}
        aria-label="${md(d)} ${v ? `점심 ${won(v)}` : '점심 기록 없음'}${dinner ? ', 회식 있음' : ''}" aria-pressed="${home.day === d}">
        <span class="cd">${parseDate(d).getDate()}</span><span class="ca">${v ? man(v) : ''}</span>
        <span class="cb"><i style="width:${v / max * 100}%"></i></span>${dinner ? '<span class="cdot"></span>' : ''}
      </button>`;
    }).join('');
    if (home.day && days.includes(home.day)) rows += dayCard(home.day, days.indexOf(home.day));
  }
  return `
    <div class="cal-head">
      <button data-act="month-prev" aria-label="이전 달">‹</button><b>${month.slice(0, 4)}년 ${Number(month.slice(5))}월</b><button data-act="month-next" aria-label="다음 달">›</button>
    </div>
    <div class="cal-grid">${DOW.slice(1, 6).map(w => `<span class="cal-dow">${w}</span>`).join('')}${rows}</div>
    <div class="legend cal-legend"><span><i class="bar"></i>막대 = 그날 점심값 (가장 많은 날 기준)</span><span><i class="dot"></i>회식한 날</span></div>
    ${weekend ? `<p class="hint">주말 기록 ${weekend}건은 달력에 없어요. 내역에서 확인하세요.</p>` : '<p class="hint">날짜를 누르면 그날 내역이 작은 카드로 보여요.</p>'}`;
}

function dayCard(d, col) {
  const meals = homeMeals().filter(m => m.date === d).sort((a, b) => a.createdAt - b.createdAt);
  return `<div class="cal-pop" role="region" aria-label="${md(d)} 내역">
    <span class="arrow" style="left: calc(${col * 20 + 10}% - 6px)"></span>
    <div class="cal-pop-head"><b>${fmtDate(d)} 내역 ${meals.length}건</b><button data-act="close-day" aria-label="닫기">✕</button></div>
    ${meals.map(m => {
      const n = m.participants.length;
      return `<div class="cal-pop-row">
        <span class="badge ${m.type === '회식' ? 'dinner-b' : 'lunch'}">${esc(m.type)}</span>
        <div><div class="r1"><b>${esc(m.place || m.type)}</b><b>${won(amt(m))}</b></div>
        <span class="sub">${n}명 · ${isMe() ? `내 몫 · 전체 ${won(m.total)}` : `1인 ${won(Math.round(m.total / n))}`}${m.type === '회식' ? ' · 평균 제외' : ''}${m.voucher ? ` · 상품권 ${m.voucher.rate}%` : ''}</span></div>
      </div>`;
    }).join('')}
    <button class="linkbtn" data-go="list">내역에서 보기 →</button>
  </div>`;
}

$('#homeBody').addEventListener('click', e => {
  const t = e.target.closest('button'); if (!t || t.disabled) return;
  const d = t.dataset;
  if (d.go) return showTab(d.go);
  if (d.who) { home.who = d.who; home.slice = null; }
  else if (d.cmp) home.cmp = d.cmp;
  else if (d.panel) return setPanel(Number(d.panel));   // 다시 그리지 않고 옮겨야 애니메이션이 보임
  else if (d.week) home.week = Number(d.week);
  else if (d.pie) { home.pie = d.pie; home.slice = null; }
  else if (d.slice) home.slice = home.slice === Number(d.slice) ? null : Number(d.slice);
  else if (d.day) home.day = home.day === d.day ? null : d.day;
  else if (d.act === 'close-day') home.day = null;
  else if (d.act === 'month-prev' || d.act === 'month-next') {
    const m = home.month || todayStr().slice(0, 7);
    const dt = new Date(Number(m.slice(0, 4)), Number(m.slice(5)) - 1 + (d.act === 'month-next' ? 1 : -1), 1);
    home.month = dateStr(dt).slice(0, 7); home.day = null;
  } else return;
  renderHome();
});
// 그래프 카드 넘기기: 화면을 다시 그리지 않고 위치·탭·점·높이만 바꿈
const HINTS = ['← 밀거나 탭을 눌러 다음 그래프', '← 밀거나 탭을 눌러 다음 그래프', '→ 밀어서 이전 그래프'];
function setPanel(i) {
  home.panel = i;
  const root = $('#homeBody'), track = root.querySelector('.ctrack');
  if (!track) return;
  track.style.transition = '';
  track.style.transform = `translateX(${-100 * i}%)`;
  root.querySelectorAll('.ctabs button').forEach((b, k) => { b.classList.toggle('on', k === i); b.setAttribute('aria-selected', k === i); });
  root.querySelectorAll('.cpanel').forEach((p, k) => p.setAttribute('aria-hidden', k !== i));
  root.querySelectorAll('.dots span').forEach((s, k) => s.classList.toggle('on', k === i));
  root.querySelector('.dots em').textContent = HINTS[i];
  fitPanel();
}
// 카드 높이를 지금 보는 그래프에 맞춤 (CSS transition으로 부드럽게)
function fitPanel() {
  const view = $('#homeBody .cview');
  const p = view && view.querySelectorAll('.cpanel')[home.panel];
  if (p) view.style.height = p.offsetHeight + 'px';
}

// 손가락·마우스로 끌면 그래프가 따라오고, 놓으면 다음/이전/제자리로 미끄러짐
let drag = null, swallowClick = false;
$('#homeBody').addEventListener('pointerdown', e => {
  const view = e.target.closest('.cview');
  if (view) drag = { x: e.clientX, y: e.clientY, dx: 0, t: performance.now(), moved: false, view };
});
$('#homeBody').addEventListener('pointermove', e => {
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (!drag.moved) {
    if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
    if (Math.abs(dy) > Math.abs(dx)) { drag = null; return; }   // 세로로 움직이면 화면 스크롤에 맡김
    drag.moved = true;
    drag.view.setPointerCapture?.(e.pointerId);
  }
  drag.dx = dx;
  const edge = (home.panel === 0 && dx > 0) || (home.panel === 2 && dx < 0);   // 처음·끝에서는 뻑뻑하게
  const track = drag.view.querySelector('.ctrack');
  track.style.transition = 'none';
  track.style.transform = `translateX(calc(${-100 * home.panel}% + ${edge ? dx / 3 : dx}px))`;
});
function endDrag() {
  if (!drag) return;
  const d = drag; drag = null;
  if (!d.moved) return;
  swallowClick = true;   // 끌다 놓을 때 버튼이 눌리지 않게
  setTimeout(() => (swallowClick = false), 0);
  const fast = Math.abs(d.dx) / (performance.now() - d.t) > 0.5 && Math.abs(d.dx) > 20;   // 짧게 튕기기
  const far = Math.abs(d.dx) > d.view.clientWidth * 0.2;
  let next = home.panel;
  if ((fast || far) && d.dx < 0 && next < 2) next++;
  if ((fast || far) && d.dx > 0 && next > 0) next--;
  setPanel(next);
}
$('#homeBody').addEventListener('pointerup', endDrag);
$('#homeBody').addEventListener('pointercancel', endDrag);
$('#homeBody').addEventListener('click', e => {
  if (swallowClick) { e.stopPropagation(); e.preventDefault(); swallowClick = false; }
}, true);

/* ===================== ① 기록 탭 ===================== */
function blankForm(keep = {}) {
  return {
    editId: null,
    date: keep.date || todayStr(),
    type: keep.type || '점심',
    place: '',
    split: (keep.type || '점심') === '회식' ? 'equal' : 'individual',
    participants: ['me'],
    total: 0, items: {}, common: 0, memo: '',
    base: 0, fixed: {}, menus: {}, baseMenu: '',
    voucher: false, voucherRate: null,   // voucherRate: 수정 중인 기록의 할인율(새 기록은 설정값)
  };
}
let form = blankForm();

function renderRecord() {
  $('#fDate').value = form.date;
  setSeg('#fType', form.type);
  $('#fPlace').value = form.place;
  setSeg('#fSplit', form.split);
  $('#fTotal').value = form.total ? fmt(form.total) : '';
  $('#fCommon').value = form.common ? fmt(form.common) : '';
  $('#fBase').value = form.base ? fmt(form.base) : '';
  $('#fBaseMenu').value = form.baseMenu;
  $('#fBaseMenuEq').value = form.baseMenu;
  $('#fMemo').value = form.memo;
  renderVoucher();
  $('#editBanner').hidden = !form.editId;
  $('#saveBtn').textContent = form.editId ? '수정 완료' : '저장';

  // 자주 간 식당 자동완성
  const cnt = {};
  state.meals.forEach(m => { if (m.place) cnt[m.place] = (cnt[m.place] || 0) + 1; });
  $('#placeList').innerHTML = Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a]).slice(0, 30)
    .map(p => `<option value="${esc(p)}">`).join('');
  renderPeople();
  renderSplitBoxes();
}

function renderPeople() {
  const shown = state.members.filter(m => m.active || form.participants.includes(m.id));
  $('#fPeople').innerHTML = shown.map(m =>
    `<button class="chip ${form.participants.includes(m.id) ? 'on' : ''}" data-id="${m.id}">${esc(label(m.id))}</button>`
  ).join('');
  $('#noMembersHint').hidden = state.members.length > 1;
}

function renderSplitBoxes() {
  $('#equalBox').hidden = form.split !== 'equal';
  $('#indivBox').hidden = form.split !== 'individual';
  if (form.split === 'individual') renderIndivRows();
  else renderFixed();
  if (menuTarget !== 'base' && !form.participants.includes(menuTarget)) menuTarget = 'base';
  renderFillLast();
  renderPreview();
}

function renderIndivRows() {
  const ids = ordered(form.participants);
  $('#indivRows').innerHTML = ids.length
    ? ids.map(id => `
      <div class="irow menu">
        <span class="iname">${esc(label(id))}</span>
        <input type="text" class="menu-input" data-menu="${id}" value="${esc(form.menus[id] || '')}" placeholder="${esc(form.baseMenu || '메뉴')}" autocomplete="off">
        <div class="amount-input sm">
          <input type="text" inputmode="numeric" pattern="[0-9]*" data-id="${id}" value="${form.items[id] ? fmt(form.items[id]) : ''}" placeholder="${form.base ? fmt(form.base) : '0'}">
          <span>원</span>
        </div>
      </div>`).join('')
    : `<p class="hint" style="margin:0 0 8px">참석자를 먼저 선택하세요.</p>`;
  renderMenuPick();
}

// 1/N: 따로 정할 사람 고르기 + 금액 칸
function renderFixed() {
  const ids = ordered(form.participants);
  $('#fFixedPick').innerHTML = ids.map(id =>
    `<button class="chip small ${id in form.fixed ? 'on' : ''}" data-id="${id}">${esc(label(id))}</button>`).join('');
  $('#fixedRows').innerHTML = fixedIds(form).map(id => `
    <div class="irow">
      <span class="iname">${esc(label(id))}</span>
      <div class="amount-input sm">
        <input type="text" inputmode="numeric" pattern="[0-9]*" data-id="${id}" value="${form.fixed[id] ? fmt(form.fixed[id]) : ''}" placeholder="0">
        <span>원</span>
      </div>
    </div>`).join('');
  renderFixedHint();
  $('#eqMenuRows').innerHTML = ids.map(id => `
    <div class="irow menu-only">
      <span class="iname">${esc(label(id))}</span>
      <input type="text" class="menu-input" data-menu="${id}" value="${esc(form.menus[id] || '')}" placeholder="${esc(form.baseMenu || '메뉴')}" autocomplete="off">
    </div>`).join('');
  renderMenuPick();
}
function renderFixedHint() {
  const fx = fixedIds(form), rest = ordered(form.participants).length - fx.length;
  const hint = $('#fixedHint');
  hint.hidden = !fx.length;
  if (!fx.length) return;
  const left = form.total - fixedSum(form);
  hint.classList.toggle('danger', left < 0 || (!rest && left !== 0));
  hint.textContent = left < 0 ? `따로 정한 금액이 총 결제액보다 ${won(-left)} 많아요.`
    : !rest ? (left ? `모두 따로 정했다면 합계가 총 결제액과 같아야 해요. (${won(left)} 남음)` : '모두 따로 정했어요.')
    : `나머지 ${rest}명이 ${won(left)}을 1/N로 나눠요.`;
}

// 같은 식당의 가장 최근 '개별 금액' 기록
function lastMealAt(place) {
  const p = place.trim();
  if (!p) return null;
  return [...state.meals]
    .filter(m => m.place === p && m.split === 'individual' && m.id !== form.editId)
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt)[0] || null;
}
// 저장된 메뉴: state.menuBook = { 식당: { 메뉴: 가격 } }. 기록을 저장할 때만 등록(가격 0 = 1/N이라 모름)
const bookAt = place => state.menuBook[place.trim()] || {};
// 메뉴 박스를 누르면 들어갈 칸: 'base'(기본) 또는 팀원 id. 메뉴 칸을 누를 때 바뀜
let menuTarget = 'base';
function renderMenuPick() {
  const book = bookAt(form.place), names = Object.keys(book);
  const target = menuTarget === 'base' ? '기본' : label(menuTarget);
  $$('.menu-pick').forEach(el => {
    el.innerHTML = names.length
      ? `<div class="sub">저장된 메뉴 · 누르면 <b>${esc(target)}</b> 칸에 들어가요</div>
         <div class="mchips">${names.map(n => `<button class="mchip" data-pick="${esc(n)}">${esc(n)}${book[n] ? `<span>${fmt(book[n])}</span>` : ''}</button>`).join('')}</div>`
      : '';
  });
  $$('.menu-input').forEach(i => i.classList.toggle('target', (i.dataset.menu || 'base') === menuTarget && names.length > 0));
}
// 저장할 때 이 기록의 메뉴·가격을 등록 (같은 메뉴는 최근 가격으로 덮어씀)
function rememberMenus(meal) {
  if (!meal.menus) return;
  const book = (state.menuBook[meal.place] ||= {});
  Object.entries(meal.menus).forEach(([id, menu]) => {
    const price = meal.split === 'individual' ? meal.items[id] || 0 : 0;
    book[menu] = price || book[menu] || 0;
  });
}
// 아는 메뉴를 고르면 지난번 가격을 넣음. 비어 있거나 자동으로 넣었던 칸만 (직접 쓴 금액은 그대로)
function fillPrice(menu, id) {
  const price = form.split === 'individual' && bookAt(form.place)[menu.trim()];
  if (!price) return;
  const auto = (form.auto ||= {});
  if (id === 'base') {
    if (form.base && !auto.base) return;
    form.base = price; auto.base = true;
    $('#fBase').value = fmt(price);
    $$('#indivRows input[data-id]').forEach(i => (i.placeholder = fmt(price)));
  } else {
    if (form.items[id] && !auto[id]) return;
    form.items[id] = price; auto[id] = true;
    const input = $(`#indivRows input[data-id="${id}"]`);
    if (input) input.value = fmt(price);
  }
}

function renderFillLast() {
  const last = form.split === 'individual' ? lastMealAt(form.place) : null;
  const btn = $('#fillLast');
  btn.hidden = !last;
  if (last) btn.textContent = `지난번(${fmtDate(last.date)}) 금액 불러오기`;
}

function renderVoucher() {
  $('#fVoucher').checked = form.voucher;
  $('#vCard').classList.toggle('on', form.voucher);
  $('#vSub').textContent = `모두의 몫에서 ${form.voucherRate ?? state.voucherRate}% 빼고 정산해요`;
}

function renderPreview() {
  const ids = ordered(form.participants);
  const { shares, voucher } = finalShares(form);
  const total = sum(shares);
  const box = $('#preview');
  if (!ids.length || !total) {
    box.innerHTML = `<div class="sub">참석자와 금액을 입력하면 1인당 금액이 여기 표시돼요.</div>`;
    return;
  }
  const mine = shares.me || 0;
  box.innerHTML = `
    <div class="pv-head">
      <span class="sub">총 ${won(voucher ? voucher.gross : total)} · ${ids.length}명</span>
      <b>받을 돈 ${won(total - mine)}</b>
    </div>
    ${voucher ? `<div class="pv-disc"><span>상품권 ${voucher.rate}% 할인</span><span>−${won(voucher.gross - total)}</span></div>
      <div class="pv-disc plain"><span>실제 결제</span><span>${won(total)}</span></div>` : ''}
    ${ids.map(id => `<div class="pv-row ${id === 'me' ? 'me' : ''}"><span>${esc(label(id))}${form.split === 'equal' && id in form.fixed ? ' <span class="sub">따로</span>' : ''}${menuIn(form, id) ?` <span class="sub">${esc(menuIn(form, id))}</span>` : ''}</span><span>${voucher ? `<s>${fmt(voucher.grossShares[id])}</s>` : ''}${won(shares[id])}</span></div>`).join('')}
  `;
}

// --- 입력 이벤트 ---
$('#fDate').addEventListener('change', e => (form.date = e.target.value));
$('#fType').addEventListener('click', e => {
  const v = e.target.closest('button')?.dataset.v; if (!v) return;
  form.type = v;
  form.split = v === '회식' ? 'equal' : 'individual';   // 점심=개별, 회식=1/N 기본값
  setSeg('#fType', v); setSeg('#fSplit', form.split);
  renderSplitBoxes();
});
$('#fPlace').addEventListener('input', e => { form.place = e.target.value; renderFillLast(); renderMenuPick(); });
$('#fMemo').addEventListener('input', e => (form.memo = e.target.value));
$('#fVoucher').addEventListener('change', e => { form.voucher = e.target.checked; renderVoucher(); renderPreview(); });

$('#fPeople').addEventListener('click', e => {
  const id = e.target.closest('.chip')?.dataset.id; if (!id) return;
  form.participants = form.participants.includes(id)
    ? form.participants.filter(x => x !== id)
    : [...form.participants, id];
  renderPeople(); renderSplitBoxes();
});
$('#pickLast').addEventListener('click', () => {
  form.participants = state.lastParticipants.filter(id => member(id)?.active);
  renderPeople(); renderSplitBoxes();
});
$('#pickAll').addEventListener('click', () => {
  form.participants = state.members.filter(m => m.active).map(m => m.id);
  renderPeople(); renderSplitBoxes();
});
$('#pickNone').addEventListener('click', () => {
  form.participants = [];
  renderPeople(); renderSplitBoxes();
});
$('#goSettings').addEventListener('click', () => showTab('settings'));

$('#fSplit').addEventListener('click', e => {
  const v = e.target.closest('button')?.dataset.v; if (!v) return;
  form.split = v; setSeg('#fSplit', v); renderSplitBoxes();
});

// 금액 입력 시 천 단위 콤마 자동 표시
function bindAmount(input, onValue) {
  input.addEventListener('input', () => {
    const v = toNum(input.value);
    input.value = v ? fmt(v) : '';
    onValue(v);
  });
}
bindAmount($('#fTotal'), v => { form.total = v; renderFixedHint(); renderPreview(); });
bindAmount($('#fBase'), v => {
  form.base = v;
  if (form.auto) delete form.auto.base;   // 직접 쓴 금액은 메뉴를 바꿔도 덮어쓰지 않음
  $$('#indivRows input[data-id]').forEach(i => (i.placeholder = v ? fmt(v) : '0'));   // 다시 그리지 않아 입력 중 커서 유지
  renderPreview();
});
$('#fFixedPick').addEventListener('click', e => {
  const id = e.target.closest('.chip')?.dataset.id; if (!id) return;
  if (id in form.fixed) delete form.fixed[id]; else form.fixed[id] = 0;
  renderFixed(); renderPreview();
  if (id in form.fixed) $(`#fixedRows input[data-id="${id}"]`)?.focus();
});
$('#fixedRows').addEventListener('input', e => {
  const input = e.target; if (!input.dataset.id) return;
  const v = toNum(input.value);
  input.value = v ? fmt(v) : '';
  form.fixed[input.dataset.id] = v;
  renderFixedHint(); renderPreview();
});
bindAmount($('#fCommon'), v => { form.common = v; renderPreview(); });
// 기본 메뉴 칸은 개별 금액·1/N에 하나씩 있고 같은 값을 씀
$$('#fBaseMenu, #fBaseMenuEq').forEach(el => el.addEventListener('input', e => {
  form.baseMenu = e.target.value;
  $$('#fBaseMenu, #fBaseMenuEq').forEach(i => { if (i !== e.target) i.value = form.baseMenu; });
  $$('#indivRows [data-menu], #eqMenuRows [data-menu]').forEach(i => (i.placeholder = form.baseMenu || '메뉴'));
  if (e.target.id === 'fBaseMenu') fillPrice(form.baseMenu, 'base');
  renderPreview();
}));
$('#eqMenuRows').addEventListener('input', e => {
  if (e.target.dataset.menu) { form.menus[e.target.dataset.menu] = e.target.value; renderPreview(); }
});
$('#indivRows').addEventListener('input', e => {
  const input = e.target;
  if (input.dataset.menu) { form.menus[input.dataset.menu] = input.value; fillPrice(input.value, input.dataset.menu); renderPreview(); return; }
  if (!input.dataset.id) return;
  const v = toNum(input.value);
  input.value = v ? fmt(v) : '';
  form.items[input.dataset.id] = v;
  if (form.auto) delete form.auto[input.dataset.id];
  renderPreview();
});

$('#fillLast').addEventListener('click', () => {
  const last = lastMealAt(form.place); if (!last) return;
  let n = 0;
  ordered(form.participants).forEach(id => {
    if (!last.items[id]) return;
    form.items[id] = last.items[id]; n++;
    if (last.menus && last.menus[id]) form.menus[id] = last.menus[id];
  });
  if (!n) return toast('지난번과 겹치는 참석자가 없어요');
  renderIndivRows(); renderPreview();
  toast(`${n}명 금액·메뉴를 불러왔어요`);
});

// 메뉴 칸을 누르면 그 칸이 메뉴 박스의 대상이 됨
$('#tab-record').addEventListener('focusin', e => {
  const input = e.target.closest('.menu-input'); if (!input) return;
  menuTarget = input.dataset.menu || 'base'; renderMenuPick();
});
$('#tab-record').addEventListener('click', e => {
  const name = e.target.closest('[data-pick]')?.dataset.pick; if (name == null) return;
  const box = form.split === 'individual' ? '#indivBox' : '#equalBox';
  const input = menuTarget === 'base' ? $(`${box} .base-row .menu-input`) : $(`${box} [data-menu="${menuTarget}"]`);
  if (!input) return;
  input.value = name;
  input.dispatchEvent(new Event('input', { bubbles: true }));   // 입력한 것과 같게 처리(가격 채우기·미리보기)
});

$('#cancelEdit').addEventListener('click', () => {
  form = blankForm(); renderRecord(); showTab('list');
});

$('#saveBtn').addEventListener('click', saveMeal);

function saveMeal() {
  const ids = ordered(form.participants);
  if (!ids.length) return toast('참석자를 선택해 주세요');
  const { shares, voucher } = finalShares(form);
  const total = sum(shares);
  if (total <= 0) return toast('금액을 입력해 주세요');
  if (form.split === 'equal' && fixedIds(form).length) {
    const left = form.total - fixedSum(form);
    if (left < 0) return toast('따로 정한 금액이 총 결제액보다 많아요');
    if (fixedIds(form).length === ids.length && left !== 0) return toast('따로 정한 금액의 합이 총 결제액과 달라요');
  }
  if (form.split === 'individual') {
    const empty = ids.filter(id => !itemOf(form, id));
    if (empty.length && !confirm(`${empty.map(label).join(', ')}의 개별 금액이 비어 있어요. 그대로 저장할까요?`)) return;
  }

  const meal = {
    id: form.editId || uid(),
    date: form.date || todayStr(),
    type: form.type,
    place: form.place.trim(),
    split: form.split,
    participants: ids,
    items: form.split === 'individual' ? Object.fromEntries(ids.map(id => [id, itemOf(form, id)])) : {},
    common: form.split === 'individual' ? form.common : 0,
    total, shares, paid: {},
    memo: form.memo.trim(),
    createdAt: Date.now(),
  };
  if (form.split === 'individual' && form.base) meal.base = form.base;
  const menus = Object.fromEntries(ids.map(id => [id, menuIn(form, id)]).filter(([, v]) => v));
  if (Object.keys(menus).length) meal.menus = menus;
  if (form.baseMenu.trim()) meal.baseMenu = form.baseMenu.trim();
  if (form.split === 'equal' && fixedIds(form).length) meal.fixed = Object.fromEntries(fixedIds(form).map(id => [id, form.fixed[id] || 0]));
  if (voucher) meal.voucher = voucher;

  const wasEdit = !!form.editId;
  if (wasEdit) {
    const i = state.meals.findIndex(m => m.id === form.editId);
    if (i >= 0) { meal.createdAt = state.meals[i].createdAt; state.meals[i] = meal; }
  } else {
    state.meals.push(meal);
  }
  state.lastParticipants = ids;
  rememberMenus(meal);
  saveState();

  form = blankForm({ date: meal.date, type: meal.type });
  if (wasEdit) { showTab('list'); toast('수정했어요'); return; }   // showTab이 토스트를 닫으므로 그 뒤에 표시
  renderRecord(); renderTop();
  window.scrollTo(0, 0);
  toast(`저장했어요 · ${meal.place || meal.type} ${won(total)}`);
}

/* ===================== ② 내역 탭 ===================== */
let listFilter = 'open';

function renderList() {
  setSeg('#listFilter', listFilter);
  let meals = [...state.meals].sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);
  if (listFilter === 'open') meals = meals.filter(m => !isDone(m));

  if (!meals.length) {
    $('#listBody').innerHTML = `<div class="empty">${listFilter === 'open' ? '정산할 기록이 없어요.' : '아직 기록이 없어요.<br>기록 탭에서 첫 식사를 추가해 보세요.'}</div>`;
    return;
  }
  let html = '', lastDate = '';
  meals.forEach(m => {
    if (m.date !== lastDate) { html += `<div class="date-head">${fmtDateLong(m.date)}</div>`; lastDate = m.date; }
    html += mealCard(m);
  });
  $('#listBody').innerHTML = html;
}

function mealCard(m) {
  const done = isDone(m);
  const anyPaid = m.participants.some(id => isPaid(m, id));
  const shares = m.participants.map(id => {
    const paid = id !== 'me' && isPaid(m, id);
    const menu = m.menus && m.menus[id] ? ` · ${esc(m.menus[id])}` : '';
    return `<span class="share ${id === 'me' ? 'me' : ''} ${paid ? 'paid' : ''}">${esc(label(id))}${menu} ${fmt(m.shares[id])}${paid ? ' ✓' : ''}</span>`;
  }).join('');
  const status = done ? '<span class="badge ok">정산 완료</span>'
    : anyPaid ? '<span class="badge part">일부 입금</span>'
    : '<span class="badge wait">미정산</span>';
  return `
    <div class="card meal" data-id="${m.id}">
      <div class="meal-top">
        <span class="badge ${m.type === '회식' ? 'dinner' : 'lunch'}">${esc(m.type)}</span>
        <b class="meal-place">${esc(m.place || '(식당 미입력)')}</b>
        <span class="meal-total">${m.voucher ? `<s>${fmt(m.voucher.gross)}</s>` : ''}${won(m.total)}</span>
      </div>
      ${m.memo ? `<div class="meal-memo">${esc(m.memo)}</div>` : ''}
      <div class="shares">${shares}</div>
      <div class="meal-foot">
        ${status}
        ${m.voucher ? `<span class="badge voucher">상품권 ${m.voucher.rate}% 할인</span>` : ''}
        <span class="spacer"></span>
        ${anyPaid ? '<span class="sub">입금 반영됨</span>' : '<button class="linkbtn" data-act="edit">수정</button>'}
        <button class="linkbtn danger" data-act="del">삭제</button>
      </div>
    </div>`;
}

$('#listFilter').addEventListener('click', e => {
  const v = e.target.closest('button')?.dataset.v; if (!v) return;
  listFilter = v; renderList();
});

$('#listBody').addEventListener('click', e => {
  const act = e.target.closest('[data-act]')?.dataset.act; if (!act) return;
  const id = e.target.closest('.meal').dataset.id;
  const m = state.meals.find(x => x.id === id); if (!m) return;

  if (act === 'edit') {
    form = {
      editId: m.id, date: m.date, type: m.type, place: m.place, split: m.split,
      participants: [...m.participants],
      total: m.split === 'equal' ? (m.voucher ? m.voucher.gross : m.total) : 0,
      // 기본 금액과 같은 칸은 비워 둬서 기본 금액을 바꾸면 함께 바뀌게 함
      items: Object.fromEntries(Object.entries(m.items).filter(([, v]) => !m.base || v !== m.base)),
      common: m.common || 0, memo: m.memo || '',
      base: m.base || 0, fixed: { ...(m.fixed || {}) },
      // 기본 메뉴와 같은 메뉴는 비워 둠 (기본 금액과 같은 방식)
      menus: Object.fromEntries(Object.entries(m.menus || {}).filter(([, v]) => v !== m.baseMenu)),
      baseMenu: m.baseMenu || '',
      voucher: !!m.voucher, voucherRate: m.voucher ? m.voucher.rate : null,
    };
    showTab('record');
  }
  if (act === 'del') {
    const warn = m.participants.some(pid => isPaid(m, pid)) ? '\n(입금 확인된 기록도 함께 지워져요)' : '';
    if (!confirm(`${fmtDate(m.date)} ${m.place || m.type} ${won(m.total)} 기록을 삭제할까요?${warn}`)) return;
    state.meals = state.meals.filter(x => x.id !== id);
    saveState(); renderList(); renderTop();
    toast('삭제했어요', '되돌리기', () => { state.meals.push(m); saveState(); renderList(); renderTop(); });
  }
});

/* ===================== ③ 정산 탭 ===================== */
const openPersons = new Set();   // 상세내역 펼친 사람
const LATE_DAYS = 14;            // 이 날수가 넘은 미입금은 빨갛게 표시
const daysAgo = s => Math.round((parseDate(todayStr()) - parseDate(s)) / 86400000);

function personIds(per) {
  const known = state.members.map(m => m.id).filter(id => per[id]);
  const unknown = Object.keys(per).filter(id => !known.includes(id));
  return [...known, ...unknown];
}

function buildMessage(per, ids) {
  if (!ids.length) return '';
  const dates = ids.flatMap(id => per[id].items.map(x => x.m.date)).sort();
  const first = dates[0], last = dates[dates.length - 1];
  const range = first === last ? fmtDate(first) : `${fmtDate(first)}~${fmtDate(last)}`;
  const thisWeek = mondayOf(last);   // 가장 최근 기록이 있는 주
  const lines = [`[식대 정산] ${range}`, ''];
  ids.forEach(id => {
    const p = per[id];
    const hasOld = p.items.some(x => x.m.date < thisWeek);
    const saved = p.items.reduce((a, x) => a + voucherSaved(x.m, id), 0);
    const notes = [hasOld && '지난 미입금 포함', saved && `상품권 ${won(saved)} 할인`].filter(Boolean);
    lines.push(`${nameOf(id)} ${won(p.amt)}${notes.length ? ` (${notes.join(', ')})` : ''}`);
    if (state.includeDetail) p.items.forEach(x => lines.push(`  · ${fmtDate(x.m.date)} ${menuOf(x.m, id)} ${won(x.amt)}`));
  });
  const vMeals = [...new Set(ids.flatMap(id => per[id].items.map(x => x.m)))].filter(m => m.voucher)
    .sort((a, b) => a.date.localeCompare(b.date) || a.createdAt - b.createdAt);
  if (vMeals.length) {
    lines.push('');
    vMeals.forEach(m => {
      // 팀원 할인액이 모두 같으면 '1인', 다르면(개별 금액 등) '1인 평균'
      const others = m.participants.filter(id => id !== 'me').map(id => voucherSaved(m, id));
      const same = others.length && others.every(v => v === others[0]);
      const per = same ? `1인 ${won(others[0])}` : `1인 평균 ${won((m.voucher.gross - m.total) / m.participants.length)}`;
      lines.push(`※ ${fmtDate(m.date)} ${m.place || m.type}: 지역상품권 ${m.voucher.rate}% 할인 · 총 ${won(m.voucher.gross - m.total)} (${per})`);
    });
  }
  if (state.account) lines.push('', `입금 계좌: ${state.account}`);
  return lines.join('\n');
}

// 요일별 표의 열: 한 주 안이면 월~금(+기록 있는 주말), 여러 주면 기록 있는 날짜만
function tableDates(per, ids) {
  const dates = [...new Set(ids.flatMap(id => per[id].items.map(x => x.m.date)))].sort();
  const mon = mondayOf(dates[0]);
  if (mondayOf(dates[dates.length - 1]) !== mon) return dates;
  const week = [...Array(7)].map((_, i) => { const d = parseDate(mon); d.setDate(d.getDate() + i); return dateStr(d); });
  return week.filter((d, i) => i < 5 || dates.includes(d));
}

// 정산 표를 그림으로 그림 (카톡에 사진으로 보내기용)
async function drawTable(per, ids) {
  try { await document.fonts.load('700 16px "Noto Sans KR"'); } catch (_) { /* 오프라인이면 기본 글꼴 */ }
  const dates = tableDates(per, ids);
  const cell = {};   // cell[id][date] = { amt, voucher, menus }
  ids.forEach(id => {
    cell[id] = {};
    per[id].items.forEach(x => {
      const c = (cell[id][x.m.date] ||= { amt: 0, voucher: false, menus: [] });
      c.amt += x.amt; c.voucher ||= !!x.m.voucher;
      const menu = menuOf(x.m, id);
      if (!c.menus.includes(menu)) c.menus.push(menu);
    });
  });
  const C = { bg: '#ffffff', head: '#fbf1e4', text: '#3b2a20', sub: '#7a6656', line: '#f1e6d8',
    accent: '#c9450e', save: '#2f7a4f', saveBg: '#e3f1e6' };
  const F = (w, s) => `${w} ${s}px "Noto Sans KR", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif`;
  const ctx = document.createElement('canvas').getContext('2d');
  const W = (font, t) => { ctx.font = font; return ctx.measureText(t).width; };

  const pad = 24, rowH = 40, headH = 54, gap = 14, lineH = 16;
  // 사람 행 높이: 메뉴 한 줄씩 (같은 날 여러 끼면 줄이 늘어남)
  const personH = id => 40 + lineH * Math.max(1, ...dates.map(d => cell[id][d]?.menus.length || 0));
  const nameW = Math.max(64, ...ids.map(id => W(F(700, 15), nameOf(id)))) + 24;
  const dayW = Math.max(66, ...ids.flatMap(id => dates.map(d =>
    Math.max(W(F(500, 15), fmt(cell[id][d]?.amt || 0)), Math.min(110, Math.max(...(cell[id][d]?.menus || ['']).map(t => W(F(500, 12), t)))))))) + 20;
  const sumW = Math.max(80, ...ids.map(id => W(F(700, 15), fmt(per[id].amt)))) + 24;
  const tableW = nameW + dayW * dates.length + sumW;
  const range = dates.length > 1 ? `${fmtDate(dates[0])}~${fmtDate(dates[dates.length - 1])}` : fmtDate(dates[0]);
  const hasVoucher = ids.some(id => dates.some(d => cell[id][d]?.voucher));
  const foot = [hasVoucher && '초록 칸: 지역상품권 할인 적용', state.account && `입금 계좌: ${state.account}`].filter(Boolean);
  const titleH = 56;
  const width = Math.ceil(Math.max(tableW, W(F(700, 20), `식대 정산 ${range}`)) + pad * 2);
  const height = Math.ceil(pad + titleH + headH + ids.reduce((a, id) => a + personH(id), 0) + rowH + (foot.length ? gap + foot.length * 22 : 0) + pad);

  const scale = 2, cv = ctx.canvas;
  cv.width = width * scale; cv.height = height * scale;
  ctx.scale(scale, scale);
  ctx.fillStyle = C.bg; ctx.fillRect(0, 0, width, height);
  ctx.textBaseline = 'middle';
  const text = (t, x, y, font, color, align = 'left') => { ctx.font = font; ctx.fillStyle = color; ctx.textAlign = align; ctx.fillText(t, x, y); };
  // 칸보다 긴 메뉴는 …로 줄임
  const fit = (t, font, max) => {
    ctx.font = font;
    if (ctx.measureText(t).width <= max) return t;
    while (t && ctx.measureText(t + '…').width > max) t = t.slice(0, -1);
    return t + '…';
  };

  text(`식대 정산 ${range}`, pad, pad + 14, F(700, 20), C.text);
  text(`미입금 ${ids.length}명 · 합계 ${won(ids.reduce((a, id) => a + per[id].amt, 0))}`, pad, pad + 40, F(500, 13), C.sub);

  let y = pad + titleH;
  const colX = i => pad + nameW + dayW * i;
  ctx.fillStyle = C.head; ctx.fillRect(pad, y, tableW, headH);
  dates.forEach((d, i) => {
    const cx = colX(i) + dayW / 2;
    text(DOW[parseDate(d).getDay()], cx, y + 19, F(700, 15), C.text, 'center');
    text(`${parseDate(d).getMonth() + 1}/${parseDate(d).getDate()}`, cx, y + 38, F(500, 12), C.sub, 'center');
  });
  text('합계', colX(dates.length) + sumW / 2, y + headH / 2, F(700, 15), C.text, 'center');
  y += headH;

  const rows = [...ids.map(id => ({ h: personH(id), name: nameOf(id), cells: dates.map(d => cell[id][d]), total: per[id].amt })),
    { name: '합계', sumRow: true,
      cells: dates.map(d => ({ amt: ids.reduce((a, id) => a + (cell[id][d]?.amt || 0), 0) })),
      total: ids.reduce((a, id) => a + per[id].amt, 0) }];
  const rowTops = [];
  rows.forEach(r => {
    const h = r.sumRow ? rowH : r.h;
    rowTops.push(y);
    if (r.sumRow) { ctx.fillStyle = C.head; ctx.fillRect(pad, y, tableW, h); }
    text(r.name, pad + 12, y + h / 2, F(700, 15), C.text);
    r.cells.forEach((c, i) => {
      const amt = c?.amt || 0, right = colX(i) + dayW - 10;
      if (c?.voucher) { ctx.fillStyle = C.saveBg; ctx.fillRect(colX(i) + 1, y + 1, dayW - 2, h - 2); }
      const menus = !r.sumRow && amt ? c.menus : [];
      text(amt ? fmt(amt) : '-', right, y + (menus.length ? 21 : h / 2), F(r.sumRow ? 700 : 500, 15),
        amt ? (c?.voucher ? C.save : C.text) : C.sub, 'right');
      menus.forEach((t, k) => text(fit(t, F(500, 12), dayW - 16), right, y + 40 + lineH * k, F(500, 12), C.sub, 'right'));
    });
    text(fmt(r.total), colX(dates.length) + sumW - 12, y + h / 2, F(700, 15), C.accent, 'right');
    y += h;
  });

  // 격자
  ctx.strokeStyle = C.line; ctx.lineWidth = 1;
  const top = pad + titleH, bottom = y;
  ctx.strokeRect(pad + .5, top + .5, tableW - 1, bottom - top - 1);
  [nameW, ...dates.map((_, i) => nameW + dayW * (i + 1))].forEach(x => {
    ctx.beginPath(); ctx.moveTo(pad + x + .5, top); ctx.lineTo(pad + x + .5, bottom); ctx.stroke();
  });
  rowTops.forEach(ry => { ctx.beginPath(); ctx.moveTo(pad, ry + .5); ctx.lineTo(pad + tableW, ry + .5); ctx.stroke(); });

  foot.forEach((t, i) => text(t, pad, y + gap + 11 + i * 22, F(500, 13), i === 0 && hasVoucher ? C.save : C.sub));
  return cv;
}

function paidBatches() {
  const map = {};
  state.meals.forEach(m => Object.entries(m.paid || {}).forEach(([id, ts]) => {
    if (!ts) return;
    const k = id + '|' + ts;
    (map[k] ||= { id, ts, amt: 0, n: 0 });
    map[k].amt += m.shares[id] || 0; map[k].n++;
  }));
  return Object.values(map).sort((a, b) => b.ts - a.ts).slice(0, 10);
}

function renderSettle() {
  const per = outstanding();
  const ids = personIds(per);
  const total = ids.reduce((a, id) => a + per[id].amt, 0);
  const mealCount = new Set(ids.flatMap(id => per[id].items.map(x => x.m.id))).size;
  const msg = buildMessage(per, ids);
  const batches = paidBatches();
  const saved = ids.reduce((a, id) => a + per[id].items.reduce((b, x) => b + voucherSaved(x.m, id), 0), 0);
  const canShare = !!navigator.share;
  let html = '';

  // 요약
  html += `
    <div class="card ${total ? 'hero' : ''}">
      <div class="sub">아직 받을 돈</div>
      <div class="big">${won(total)}</div>
      <div class="sub">${total ? `미입금 기록 ${mealCount}건 · ${ids.length}명` : '모두 정산됐어요'}</div>
      ${saved ? `<div class="save-line">지역상품권으로 팀원 몫 ${won(saved)} 할인됐어요</div>` : ''}
    </div>`;

  // 이번 주(월~일) 식비: 전체 결제액과 그중 내 몫 (상품권 할인 반영된 실제 금액)
  const mon = mondayOf(todayStr()), sun = addDays(mon, 6);
  const week = state.meals.filter(m => m.date >= mon && m.date <= sun);
  const wTotal = week.reduce((a, m) => a + m.total, 0);
  const wMine = week.reduce((a, m) => a + (m.shares.me || 0), 0);
  const wDinner = week.filter(m => m.type === '회식').reduce((a, m) => a + m.total, 0);
  html += `
    <div class="card">
      <div class="label"><span>이번 주 식비</span><span class="sub">${md(mon)}~${md(sun)} · ${week.length}건</span></div>
      <div class="week-sum">
        <div><span class="sub">전체</span><b>${won(wTotal)}</b></div>
        <div><span class="sub">내가 쓴 금액</span><b>${won(wMine)}</b></div>
      </div>
      ${wDinner ? `<p class="hint">전체 중 점심 ${won(wTotal - wDinner)} · 회식 ${won(wDinner)}</p>` : ''}
    </div>`;

  // 사람별
  if (ids.length) {
    html += `<div class="card"><div class="label">사람별 금액 <span class="sub">이름을 누르면 상세</span></div>`;
    ids.forEach(id => {
      const p = per[id];
      const open = openPersons.has(id);
      const oldest = daysAgo(p.items[0].m.date);   // items는 날짜순
      html += `
        <div class="person" data-id="${id}">
          <div class="person-line">
            <button class="person-main" data-act="toggle">
              <span><b>${esc(nameOf(id))}</b> <span class="sub">${p.items.length}건 ${open ? '▴' : '▾'}</span>${oldest > LATE_DAYS ? ` <span class="badge late">${oldest}일 지남</span>` : ''}</span>
              <span class="person-amt">${won(p.amt)}</span>
            </button>
            <button class="btn small ok" data-act="paid">입금 확인</button>
          </div>
          <div class="person-detail" ${open ? '' : 'hidden'}>
            ${p.items.map(x => `<div class="drow ${daysAgo(x.m.date) > LATE_DAYS ? 'late' : ''}"><span>${fmtDate(x.m.date)} ${esc(menuOf(x.m, id))}${x.m.voucher ? `<i class="vtag">−${x.m.voucher.rate}%</i>` : ''}</span><span>${won(x.amt)}</span></div>`).join('')}
            <div class="pd-actions">
              <button class="linkbtn" data-act="msg">${esc(nameOf(id))}에게 보낼 메시지 복사</button>
              ${canShare ? '<button class="linkbtn" data-act="msg-share">공유</button>' : ''}
            </div>
          </div>
        </div>`;
    });
    html += `</div>`;

    // 메시지
    html += `
      <div class="card">
        <div class="label">정산 메시지</div>
        <label class="check"><input type="checkbox" id="detailChk" ${state.includeDetail ? 'checked' : ''}> 날짜별 상세 내역 포함</label>
        <pre class="msg" id="msgBox">${esc(msg)}</pre>
        <div class="btnrow">
          <button class="btn primary" id="copyBtn">메시지 복사</button>
          ${canShare ? '<button class="btn" id="shareBtn">카톡 등으로 공유</button>' : ''}
        </div>
        ${state.account ? '' : '<p class="hint">설정에서 입금 계좌를 넣으면 메시지에 함께 표시돼요.</p>'}
      </div>`;

    // 요일별 표 (이미지)
    html += `
      <div class="card">
        <div class="label">요일별 표 <span class="sub">사진으로 보내기</span></div>
        <div class="table-img"><img id="tableImg" alt="요일별 정산 표"></div>
        <div class="btnrow">
          ${canShareImage() ? '<button class="btn primary" id="shareImgBtn">표 이미지 공유</button>' : ''}
          <button class="btn" id="saveImgBtn">이미지 저장</button>
        </div>
      </div>`;
  }

  // 최근 입금 확인 (실수했을 때 취소)
  if (batches.length) {
    html += `<div class="card"><div class="label">최근 입금 확인</div>`;
    batches.forEach(b => {
      html += `
        <div class="batch">
          <span><b>${esc(nameOf(b.id))}</b> ${won(b.amt)} <span class="sub">· ${b.n}건 · ${fmtTime(b.ts)}</span></span>
          <button class="linkbtn danger" data-undo="${b.id}|${b.ts}">취소</button>
        </div>`;
    });
    html += `</div>`;
  }

  $('#settleBody').innerHTML = html;
  if (ids.length) {
    const ver = ++tableVer;
    tableCanvas = null;
    drawTable(per, ids).then(cv => {
      if (ver !== tableVer || !$('#tableImg')) return;   // 그리는 사이 화면이 다시 그려졌으면 버림
      tableCanvas = cv;
      $('#tableImg').src = cv.toDataURL('image/png');
    });
  }
}

let tableCanvas = null, tableVer = 0;
const tableFileName = () => `식대정산_${todayStr()}.png`;
const canShareImage = () => {
  try { return !!navigator.canShare?.({ files: [new File([''], 'a.png', { type: 'image/png' })] }); }
  catch (_) { return false; }
};
const canvasBlob = cv => new Promise(res => cv.toBlob(res, 'image/png'));

function markPaid(id) {
  const ts = Date.now();
  let amt = 0;
  state.meals.forEach(m => {
    if (m.participants.includes(id) && (m.shares[id] || 0) > 0 && !isPaid(m, id)) {
      (m.paid ||= {})[id] = ts;
      amt += m.shares[id];
    }
  });
  saveState(); openPersons.delete(id); renderSettle(); renderTop();
  toast(`${nameOf(id)} ${won(amt)} 입금 확인`, '되돌리기', () => undoPaid(id, ts));
}
function undoPaid(id, ts) {
  state.meals.forEach(m => { if (m.paid && m.paid[id] === ts) delete m.paid[id]; });
  saveState(); renderSettle(); renderTop();
  toast('입금 확인을 취소했어요');
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch (e) {
    // http 환경 등 clipboard API를 못 쓸 때 대체 방법
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, text.length);
    let ok = false; try { ok = document.execCommand('copy'); } catch (_) {}
    ta.remove(); return ok;
  }
}

$('#settleBody').addEventListener('click', async e => {
  const undo = e.target.closest('[data-undo]')?.dataset.undo;
  if (undo) { const [id, ts] = undo.split('|'); return undoPaid(id, Number(ts)); }

  if (e.target.closest('#copyBtn')) {
    const ok = await copyText($('#msgBox').textContent);
    return toast(ok ? '복사했어요. 카톡 단톡방에 붙여넣기 하세요' : '복사에 실패했어요. 메시지를 길게 눌러 복사해 주세요');
  }
  if (e.target.closest('#shareBtn')) {
    try { await navigator.share({ text: $('#msgBox').textContent }); } catch (_) {}
    return;
  }
  if (e.target.closest('#shareImgBtn, #saveImgBtn')) {
    if (!tableCanvas) return toast('표를 만드는 중이에요. 잠시 후 다시 눌러 주세요');
    const blob = await canvasBlob(tableCanvas);
    if (e.target.closest('#saveImgBtn')) { downloadBlob(blob, tableFileName()); return toast('표 이미지를 저장했어요'); }
    try { await navigator.share({ files: [new File([blob], tableFileName(), { type: 'image/png' })] }); } catch (_) {}
    return;
  }

  const act = e.target.closest('[data-act]')?.dataset.act; if (!act) return;
  const id = e.target.closest('.person').dataset.id;
  if (act === 'toggle') { openPersons.has(id) ? openPersons.delete(id) : openPersons.add(id); renderSettle(); }
  if (act === 'paid') markPaid(id);
  if (act === 'msg' || act === 'msg-share') {
    const text = buildMessage(outstanding(), [id]);   // 그 사람 몫만 담은 개인 메시지
    if (act === 'msg-share') { try { await navigator.share({ text }); } catch (_) {} return; }
    const ok = await copyText(text);
    toast(ok ? `${nameOf(id)} 메시지를 복사했어요` : '복사에 실패했어요');
  }
});
$('#settleBody').addEventListener('change', e => {
  if (e.target.id === 'detailChk') { state.includeDetail = e.target.checked; saveState(); renderSettle(); }
});

/* ===================== ④ 설정 탭 ===================== */
const usedIds = () => new Set(state.meals.flatMap(m => m.participants));

function renderSettings() {
  $('#sMe').value = nameOf('me') === '나' ? '' : nameOf('me');
  $('#sAccount').value = state.account;
  setSeg('#sRound', state.rounding);
  $('#sVoucher').value = state.voucherRate;
  if (!$('#xFrom').value) $('#xFrom').value = todayStr().slice(0, 8) + '01';   // 기본: 이번 달 1일 ~ 오늘
  if (!$('#xTo').value) $('#xTo').value = todayStr();
  renderXlsxHint();
  renderMenuBook();
  const used = usedIds();
  const others = state.members.filter(m => m.id !== 'me');
  $('#memberList').innerHTML = others.length ? others.map(m => `
    <div class="mrow ${m.active ? '' : 'off'}" data-id="${m.id}">
      <input type="text" value="${esc(m.name)}" data-act="rename">
      ${used.has(m.id)
        ? `<button class="btn small" data-act="toggle">${m.active ? '숨기기' : '보이기'}</button>`
        : `<button class="btn small" data-act="remove" style="color:var(--danger)">삭제</button>`}
    </div>`).join('') : `<p class="hint" style="margin:0 0 10px">함께 식사하는 팀원을 추가해 주세요.</p>`;
}

$('#sMe').addEventListener('change', e => {
  member('me').name = e.target.value.trim() || '나'; saveState();
});
$('#sAccount').addEventListener('change', e => { state.account = e.target.value.trim(); saveState(); });
$('#sRound').addEventListener('click', e => {
  const v = e.target.closest('button')?.dataset.v; if (!v) return;
  state.rounding = v; saveState(); setSeg('#sRound', v);
});

$('#sVoucher').addEventListener('change', e => {
  const v = toNum(e.target.value);
  if (v < 1 || v > 50) { e.target.value = state.voucherRate; return toast('할인율은 1~50% 사이로 넣어 주세요'); }
  state.voucherRate = v; e.target.value = v; saveState();
  toast(`지역상품권 할인율을 ${v}%로 바꿨어요`);
});

function renderMenuBook() {
  const places = Object.keys(state.menuBook).filter(p => Object.keys(state.menuBook[p]).length).sort();
  $('#menuBookList').innerHTML = places.length ? places.map(p => `
    <div class="mb-place" data-place="${esc(p)}">
      <div class="mb-head">${esc(p || '(식당 미입력)')}</div>
      ${Object.entries(state.menuBook[p]).map(([n, v]) => `
        <div class="mb-row"><span>${esc(n)}</span><span class="sub">${v ? won(v) : '가격 없음'}</span><button class="linkbtn danger" data-del="${esc(n)}">삭제</button></div>`).join('')}
    </div>`).join('')
    : '<p class="hint" style="margin:0">아직 저장된 메뉴가 없어요. 기록에 메뉴를 넣고 저장하면 여기에 생겨요.</p>';
}
$('#menuBookList').addEventListener('click', e => {
  const name = e.target.closest('[data-del]')?.dataset.del; if (name == null) return;
  const place = e.target.closest('.mb-place').dataset.place;
  const price = state.menuBook[place][name];
  delete state.menuBook[place][name];
  if (!Object.keys(state.menuBook[place]).length) delete state.menuBook[place];
  saveState(); renderMenuBook();
  toast(`${name} 메뉴를 지웠어요`, '되돌리기', () => { (state.menuBook[place] ||= {})[name] = price; saveState(); renderMenuBook(); });
});

function addMember() {
  const input = $('#newMember');
  const name = input.value.trim();
  if (!name) return;
  if (state.members.some(m => m.name === name)) return toast('이미 있는 이름이에요');
  state.members.push({ id: uid(), name, active: true });
  saveState(); input.value = ''; renderSettings(); input.focus();
  toast(`${name} 추가했어요`);
}
$('#addMember').addEventListener('click', addMember);
$('#newMember').addEventListener('keydown', e => { if (e.key === 'Enter') addMember(); });

$('#memberList').addEventListener('change', e => {
  if (e.target.dataset.act !== 'rename') return;
  const m = member(e.target.closest('.mrow').dataset.id);
  const name = e.target.value.trim();
  if (name) { m.name = name; saveState(); } else e.target.value = m.name;
});
$('#memberList').addEventListener('click', e => {
  const act = e.target.closest('button')?.dataset.act; if (!act) return;
  const id = e.target.closest('.mrow').dataset.id;
  if (act === 'toggle') { const m = member(id); m.active = !m.active; }
  if (act === 'remove') state.members = state.members.filter(m => m.id !== id);
  saveState(); renderSettings();
});

function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// 엑셀 내보내기: 기간 안의 기록 → 시트 3개 (식사별 / 사람별 상세 / 사람별 합계)
const mealsBetween = (from, to) => state.meals
  .filter(m => m.date >= from && m.date <= to)
  .sort((a, b) => a.date.localeCompare(b.date) || a.createdAt - b.createdAt);

function renderXlsxHint() {
  const from = $('#xFrom').value, to = $('#xTo').value;
  $('#xlsxHint').textContent = from && to && from <= to
    ? `이 기간 기록 ${mealsBetween(from, to).length}건 · 파일은 휴대폰 '다운로드' 폴더에 저장돼요.`
    : '시작일과 종료일을 확인해 주세요.';
}

function exportSheets(meals) {
  const H = v => ({ v, s: 'head' }), B = v => ({ v, s: 'bold' });
  const dow = d => DOW[parseDate(d).getDay()];
  const fullName = id => (id === 'me' ? `${nameOf('me')}(결제자)` : nameOf(id));
  const paidSum = m => m.participants.reduce((a, id) => a + (id !== 'me' && isPaid(m, id) ? m.shares[id] || 0 : 0), 0);

  const mealRows = meals.map(m => {
    const mine = m.shares.me || 0, paid = paidSum(m), toGet = m.total - mine;
    return [m.date, dow(m.date), m.type, m.place, m.split === 'equal' ? (m.fixed ? '1/N(일부 지정)' : '1/N') : '개별 금액',
      m.participants.length, ordered(m.participants).map(nameOf).join(', '),
      m.total, m.voucher ? m.voucher.gross - m.total : 0, mine, toGet, paid, toGet - paid,
      isDone(m) ? '정산 완료' : paid ? '일부 입금' : '미정산', m.memo || ''];
  });
  const col = i => mealRows.reduce((a, r) => a + r[i], 0);

  const detailRows = meals.flatMap(m => ordered(m.participants).map(id => [
    m.date, dow(m.date), m.type, m.place, fullName(id), menuOf(m, id), m.shares[id] || 0,
    id === 'me' ? '결제자' : isPaid(m, id) ? '입금 완료' : '미입금',
    id !== 'me' && isPaid(m, id) ? dateStr(new Date(m.paid[id])) : '',
  ]));

  const per = {};
  meals.forEach(m => m.participants.forEach(id => {
    const p = (per[id] ||= { n: 0, amt: 0, paid: 0 });
    p.n++; p.amt += m.shares[id] || 0;
    if (id !== 'me' && isPaid(m, id)) p.paid += m.shares[id] || 0;
  }));
  const personIdsAll = [...state.members.map(m => m.id).filter(id => per[id]), ...Object.keys(per).filter(id => !member(id))];
  const personRows = personIdsAll.map(id => id === 'me'
    ? [fullName(id), per[id].n, per[id].amt, '', '']
    : [fullName(id), per[id].n, per[id].amt, per[id].paid, per[id].amt - per[id].paid]);
  const others = personIdsAll.filter(id => id !== 'me');

  return [
    { name: '식사별', cols: [12, 6, 7, 18, 10, 6, 30, 11, 11, 11, 11, 11, 11, 10, 20], rows: [
      ['날짜', '요일', '구분', '식당', '나누는 방식', '인원', '참석자', '총액', '상품권 할인', '내 부담', '받을 돈', '입금 받은 돈', '미입금', '상태', '메모'].map(H),
      ...mealRows,
      [B('합계'), '', '', '', '', '', '', B(col(7)), B(col(8)), B(col(9)), B(col(10)), B(col(11)), B(col(12))],
    ] },
    { name: '사람별 상세', cols: [12, 6, 7, 18, 16, 18, 11, 10, 12], rows: [
      ['날짜', '요일', '구분', '식당', '이름', '메뉴', '부담액', '입금 상태', '입금 확인일'].map(H),
      ...detailRows,
    ] },
    { name: '사람별 합계', cols: [16, 10, 12, 12, 12], rows: [
      ['이름', '식사 횟수', '부담액 합계', '입금 완료', '미입금'].map(H),
      ...personRows,
      [B('팀원 합계'), '', B(others.reduce((a, id) => a + per[id].amt, 0)),
        B(others.reduce((a, id) => a + per[id].paid, 0)), B(others.reduce((a, id) => a + per[id].amt - per[id].paid, 0))],
    ] },
  ];
}

$('#xFrom').addEventListener('change', renderXlsxHint);
$('#xTo').addEventListener('change', renderXlsxHint);
$('#xlsxBtn').addEventListener('click', () => {
  const from = $('#xFrom').value, to = $('#xTo').value;
  if (!from || !to || from > to) return toast('시작일과 종료일을 확인해 주세요');
  const meals = mealsBetween(from, to);
  if (!meals.length) return toast('이 기간에는 기록이 없어요');
  downloadBlob(new Blob([buildXlsx(exportSheets(meals))], { type: XLSX_MIME }), `식대정산_${from}_${to}.xlsx`);
  toast(`엑셀 파일을 저장했어요 · ${meals.length}건`);
});

// 백업 파일 저장
$('#exportBtn').addEventListener('click', () => {
  downloadBlob(new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' }), `식대정산_백업_${todayStr()}.json`);
});
// 백업 불러오기
$('#importBtn').addEventListener('click', () => $('#importFile').click());
$('#importFile').addEventListener('change', async e => {
  const file = e.target.files[0]; if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.meals) || !Array.isArray(data.members)) throw new Error();
    if (!confirm(`기록 ${data.meals.length}건을 불러올까요? 지금 데이터는 덮어써져요.`)) return;
    state = Object.assign(defaultState(), data);
    ensureMenuBook();
    saveState(); form = blankForm(); showTab('settings');
    toast('백업을 불러왔어요');
  } catch (_) { toast('올바른 백업 파일이 아니에요'); }
  e.target.value = '';
});
$('#resetBtn').addEventListener('click', () => {
  if (!confirm('모든 기록과 팀원 정보를 지울까요? 되돌릴 수 없어요.')) return;
  state = defaultState(); ensureMenuBook(); saveState(); form = blankForm(); showTab('settings');
  toast('초기화했어요');
});

/* ===================== 시작 ===================== */
showTab(state.members.length > 1 ? 'home' : 'settings');

// 앱 설치(PWA) · 오프라인 실행용 서비스워커. https 또는 localhost에서만 동작
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
// 저장공간이 부족해도 브라우저가 기록을 자동으로 지우지 않도록 요청
navigator.storage?.persist?.().catch(() => {});
