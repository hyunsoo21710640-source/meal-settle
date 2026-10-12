/* =====================================================================
   식대 정산 앱
   - 데이터는 브라우저 localStorage에 저장 (서버 없음)
   - 구조
     state.members : [{ id, name, active }]  ← id 'me' 는 결제자(나)
     state.meals   : [{ id, date, type, place, split, participants,
                        items, common, total, shares, paid, memo, createdAt }]
        · shares : { 팀원id: 부담금액 }
        · paid   : { 팀원id: 입금확인 시각(timestamp) }  ← 없으면 미입금
   ===================================================================== */

const STORAGE_KEY = 'mealSettle.v1';

function defaultState() {
  return {
    version: 1,
    members: [{ id: 'me', name: '나', active: true }],
    account: '',
    rounding: 'none',          // none | up100 | down100
    meals: [],
    lastParticipants: ['me'],
    includeDetail: false,
  };
}

let state = loadState();

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return Object.assign(defaultState(), JSON.parse(raw));
  } catch (e) { /* 저장소 접근 불가 시 빈 상태로 시작 */ }
  return defaultState();
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

function calcShares(f) {
  const ids = ordered(f.participants);
  if (f.split === 'equal') return splitEven(f.total, ids);
  const shares = {};
  ids.forEach(id => (shares[id] = f.items[id] || 0));
  if (f.common > 0) {
    const add = splitEven(f.common, ids);
    ids.forEach(id => (shares[id] += add[id]));
  }
  return shares;
}

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
const TAB_TITLES = { record: '오늘 뭐 먹었어요?', list: '먹은 기록', settle: '정산', settings: '설정' };
let currentTab = 'record';

function showTab(tab) {
  currentTab = tab;
  $('#toast').hidden = true;
  $$('.tab').forEach(s => (s.hidden = s.id !== 'tab-' + tab));
  $$('.navbtn').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  $('#pageTitle').textContent = TAB_TITLES[tab];
  $('#saveBar').hidden = tab !== 'record';
  ({ record: renderRecord, list: renderList, settle: renderSettle, settings: renderSettings })[tab]();
  renderTop();
  window.scrollTo(0, 0);
}
$$('.navbtn').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));

function renderTop() {
  const total = sum(Object.fromEntries(Object.entries(outstanding()).map(([k, v]) => [k, v.amt])));
  const pill = $('#owePill');
  pill.hidden = !total || currentTab === 'settle';
  pill.textContent = `받을 돈 ${won(total)}`;
}
$('#owePill').addEventListener('click', () => showTab('settle'));

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
  $('#fMemo').value = form.memo;
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
  renderFillLast();
  renderPreview();
}

function renderIndivRows() {
  const ids = ordered(form.participants);
  $('#indivRows').innerHTML = ids.length
    ? ids.map(id => `
      <div class="irow">
        <span class="iname">${esc(label(id))}</span>
        <div class="amount-input sm">
          <input type="text" inputmode="numeric" pattern="[0-9]*" data-id="${id}" value="${form.items[id] ? fmt(form.items[id]) : ''}" placeholder="0">
          <span>원</span>
        </div>
      </div>`).join('')
    : `<p class="hint" style="margin:0 0 8px">참석자를 먼저 선택하세요.</p>`;
}

// 같은 식당의 가장 최근 '개별 금액' 기록
function lastMealAt(place) {
  const p = place.trim();
  if (!p) return null;
  return [...state.meals]
    .filter(m => m.place === p && m.split === 'individual' && m.id !== form.editId)
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt)[0] || null;
}
function renderFillLast() {
  const last = form.split === 'individual' ? lastMealAt(form.place) : null;
  const btn = $('#fillLast');
  btn.hidden = !last;
  if (last) btn.textContent = `지난번(${fmtDate(last.date)}) 금액 불러오기`;
}

function renderPreview() {
  const ids = ordered(form.participants);
  const shares = calcShares(form);
  const total = sum(shares);
  const box = $('#preview');
  if (!ids.length || !total) {
    box.innerHTML = `<div class="sub">참석자와 금액을 입력하면 1인당 금액이 여기 표시돼요.</div>`;
    return;
  }
  const mine = shares.me || 0;
  box.innerHTML = `
    <div class="pv-head">
      <span class="sub">총 ${won(total)} · ${ids.length}명</span>
      <b>받을 돈 ${won(total - mine)}</b>
    </div>
    ${ids.map(id => `<div class="pv-row ${id === 'me' ? 'me' : ''}"><span>${esc(label(id))}</span><span>${won(shares[id])}</span></div>`).join('')}
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
$('#fPlace').addEventListener('input', e => { form.place = e.target.value; renderFillLast(); });
$('#fMemo').addEventListener('input', e => (form.memo = e.target.value));

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
bindAmount($('#fTotal'), v => { form.total = v; renderPreview(); });
bindAmount($('#fCommon'), v => { form.common = v; renderPreview(); });
$('#indivRows').addEventListener('input', e => {
  const input = e.target; if (!input.dataset.id) return;
  const v = toNum(input.value);
  input.value = v ? fmt(v) : '';
  form.items[input.dataset.id] = v;
  renderPreview();
});

$('#fillLast').addEventListener('click', () => {
  const last = lastMealAt(form.place); if (!last) return;
  let n = 0;
  ordered(form.participants).forEach(id => { if (last.items[id]) { form.items[id] = last.items[id]; n++; } });
  if (!n) return toast('지난번과 겹치는 참석자가 없어요');
  renderIndivRows(); renderPreview();
  toast(`${n}명 금액을 불러왔어요`);
});

$('#cancelEdit').addEventListener('click', () => {
  form = blankForm(); renderRecord(); showTab('list');
});

$('#saveBtn').addEventListener('click', saveMeal);

function saveMeal() {
  const ids = ordered(form.participants);
  if (!ids.length) return toast('참석자를 선택해 주세요');
  const shares = calcShares(form);
  const total = sum(shares);
  if (total <= 0) return toast('금액을 입력해 주세요');
  if (form.split === 'individual') {
    const empty = ids.filter(id => !form.items[id]);
    if (empty.length && !confirm(`${empty.map(label).join(', ')}의 개별 금액이 비어 있어요. 그대로 저장할까요?`)) return;
  }

  const meal = {
    id: form.editId || uid(),
    date: form.date || todayStr(),
    type: form.type,
    place: form.place.trim(),
    split: form.split,
    participants: ids,
    items: form.split === 'individual' ? Object.fromEntries(ids.map(id => [id, form.items[id] || 0])) : {},
    common: form.split === 'individual' ? form.common : 0,
    total, shares, paid: {},
    memo: form.memo.trim(),
    createdAt: Date.now(),
  };

  const wasEdit = !!form.editId;
  if (wasEdit) {
    const i = state.meals.findIndex(m => m.id === form.editId);
    if (i >= 0) { meal.createdAt = state.meals[i].createdAt; state.meals[i] = meal; }
  } else {
    state.meals.push(meal);
  }
  state.lastParticipants = ids;
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
    return `<span class="share ${id === 'me' ? 'me' : ''} ${paid ? 'paid' : ''}">${esc(label(id))} ${fmt(m.shares[id])}${paid ? ' ✓' : ''}</span>`;
  }).join('');
  const status = done ? '<span class="badge ok">정산 완료</span>'
    : anyPaid ? '<span class="badge part">일부 입금</span>'
    : '<span class="badge wait">미정산</span>';
  return `
    <div class="card meal" data-id="${m.id}">
      <div class="meal-top">
        <span class="badge ${m.type === '회식' ? 'dinner' : 'lunch'}">${esc(m.type)}</span>
        <b class="meal-place">${esc(m.place || '(식당 미입력)')}</b>
        <span class="meal-total">${won(m.total)}</span>
      </div>
      ${m.memo ? `<div class="meal-memo">${esc(m.memo)}</div>` : ''}
      <div class="shares">${shares}</div>
      <div class="meal-foot">
        ${status}
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
      total: m.split === 'equal' ? m.total : 0,
      items: { ...m.items }, common: m.common || 0, memo: m.memo || '',
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
    lines.push(`${nameOf(id)} ${won(p.amt)}${hasOld ? ' (지난 미입금 포함)' : ''}`);
    if (state.includeDetail) p.items.forEach(x => lines.push(`  · ${fmtDate(x.m.date)} ${x.m.place || x.m.type} ${won(x.amt)}`));
  });
  if (state.account) lines.push('', `입금 계좌: ${state.account}`);
  return lines.join('\n');
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
  const canShare = !!navigator.share;
  let html = '';

  // 요약
  html += `
    <div class="card ${total ? 'hero' : ''}">
      <div class="sub">아직 받을 돈</div>
      <div class="big">${won(total)}</div>
      <div class="sub">${total ? `미입금 기록 ${mealCount}건 · ${ids.length}명` : '모두 정산됐어요'}</div>
    </div>`;

  // 사람별
  if (ids.length) {
    html += `<div class="card"><div class="label">사람별 금액 <span class="sub">이름을 누르면 상세</span></div>`;
    ids.forEach(id => {
      const p = per[id];
      const open = openPersons.has(id);
      html += `
        <div class="person" data-id="${id}">
          <div class="person-line">
            <button class="person-main" data-act="toggle">
              <span><b>${esc(nameOf(id))}</b> <span class="sub">${p.items.length}건 ${open ? '▴' : '▾'}</span></span>
              <span class="person-amt">${won(p.amt)}</span>
            </button>
            <button class="btn small ok" data-act="paid">입금 확인</button>
          </div>
          <div class="person-detail" ${open ? '' : 'hidden'}>
            ${p.items.map(x => `<div class="drow"><span>${fmtDate(x.m.date)} ${esc(x.m.place || x.m.type)}</span><span>${won(x.amt)}</span></div>`).join('')}
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
}

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

  const act = e.target.closest('[data-act]')?.dataset.act; if (!act) return;
  const id = e.target.closest('.person').dataset.id;
  if (act === 'toggle') { openPersons.has(id) ? openPersons.delete(id) : openPersons.add(id); renderSettle(); }
  if (act === 'paid') markPaid(id);
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

// 백업 파일 저장
$('#exportBtn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `식대정산_백업_${todayStr()}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
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
    saveState(); form = blankForm(); showTab('settings');
    toast('백업을 불러왔어요');
  } catch (_) { toast('올바른 백업 파일이 아니에요'); }
  e.target.value = '';
});
$('#resetBtn').addEventListener('click', () => {
  if (!confirm('모든 기록과 팀원 정보를 지울까요? 되돌릴 수 없어요.')) return;
  state = defaultState(); saveState(); form = blankForm(); showTab('settings');
  toast('초기화했어요');
});

/* ===================== 시작 ===================== */
showTab(state.members.length > 1 ? 'record' : 'settings');
