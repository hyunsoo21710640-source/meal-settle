# 식대 정산

팀 점심값·회식비를 내가 먼저 결제하고 매주 금요일에 정산할 때 쓰는 모바일 웹앱.
서버 없이 휴대폰 브라우저(localStorage)에 기록이 저장된다.

## 파일 구성

| 파일 | 내용 |
|---|---|
| `index.html` | 화면 구조 (탭 4개: 기록 · 내역 · 정산 · 설정) |
| `style.css` | 디자인. 색상은 맨 위 `:root` 변수에서 변경 |
| `app.js` | 동작 (금액 계산, 저장, 정산 메시지 등) |
| `context-notes.md` | 요구사항과 결정 사항. 이어서 작업할 때 먼저 읽기 |
| `checklist.md` | 완료한 일 / 다음에 할 일 |

## PC에서 실행 (VS Code)

1. VS Code 왼쪽 확장 메뉴(`Ctrl+Shift+X`)에서 **Live Server** 검색 → 설치 (처음 한 번만)
2. `index.html` 우클릭 → **Open with Live Server**
3. 브라우저에서 `F12` → `Ctrl+Shift+M`(기기 툴바)으로 휴대폰 화면 크기로 확인
4. 파일을 저장하면 브라우저가 자동으로 새로고침된다

> `index.html`을 더블클릭해서 열어도 동작은 한다.

## 휴대폰에서 쓰기 (GitHub Pages, 무료)

1. GitHub에 새 저장소를 만들고 이 폴더를 push
2. 저장소 **Settings → Pages → Branch: `main` / `(root)` → Save**
3. 1~2분 뒤 생기는 주소(`https://아이디.github.io/저장소이름/`)를 휴대폰 **Chrome/Safari**로 열기
4. 메뉴에서 **홈 화면에 추가** → 앱처럼 사용

주의
- **카카오톡 안에서 링크를 열지 말 것.** 인앱 브라우저는 저장공간이 달라 기록이 따로 쌓인다. 항상 홈 화면 아이콘으로 연다.
- 브라우저 데이터를 지우면 기록이 사라진다 → 가끔 **설정 > 백업 파일 저장**.
- 파일을 고쳐서 다시 push하면 같은 주소에 반영되고, 휴대폰에 저장된 기록은 그대로 유지된다.

## 자주 고칠 곳

| 하고 싶은 것 | 위치 |
|---|---|
| 구분(점심/회식) 추가 | `index.html`의 `#fType` 버튼 + `app.js`의 `blankForm()`, `#fType` 클릭 처리 |
| 정산 메시지 문구 | `app.js`의 `buildMessage()` |
| 1/N 끝전 계산 | `app.js`의 `splitEven()` |
| 색상·글꼴 | `style.css`의 `:root` |
| 저장 키 | `app.js`의 `STORAGE_KEY` (바꾸면 기존 기록이 안 보이니 주의) |

## 데이터 구조

```js
state = {
  members: [{ id: 'me', name: '박현수', active: true }, { id: 'abc1', name: '김철수', active: true }],
  account: '국민 000-0000 박현수',
  rounding: 'none',            // none | up100 | down100
  includeDetail: false,        // 정산 메시지에 상세 내역 포함 여부
  lastParticipants: ['me', 'abc1'],
  meals: [{
    id, date: '2026-10-12', type: '점심', place: '시골국밥', memo: '',
    split: 'individual',       // individual(개별 금액) | equal(1/N)
    participants: ['me', 'abc1'],
    items: { me: 9000, abc1: 10000 },  // 개별 금액 입력값
    common: 0,                 // 공통 금액(1/N로 추가)
    total: 19000,
    shares: { me: 9000, abc1: 10000 }, // 최종 부담액 (저장 시점에 확정)
    paid: { abc1: 1760000000000 },     // 입금 확인 시각, 없으면 미입금
    createdAt
  }]
}
```
