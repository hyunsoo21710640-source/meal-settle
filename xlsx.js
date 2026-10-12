// 외부 라이브러리 없이 .xlsx(엑셀) 파일을 만드는 작은 생성기
/* =====================================================================
   사용법
     const bytes = buildXlsx([
       { name: '시트이름', cols: [12, 20], rows: [
           [{ v: '제목', s: 'head' }, { v: '금액', s: 'head' }],
           ['김밥천국', 32000],                      // 문자열 → 글자, 숫자 → #,##0 숫자
           [{ v: '합계', s: 'bold' }, { v: 32000, s: 'bold' }],
       ] },
     ]);
     → Uint8Array (application/vnd.openxmlformats-officedocument.spreadsheetml.sheet)
   - cols: 열 너비(글자 수 기준), 첫 행은 틀 고정
   - 압축 없는 zip(STORE) + 셀 안 문자열(inlineStr) 방식이라 코드가 짧다
   ===================================================================== */

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function buildXlsx(sheets) {
  const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  // 셀 스타일 번호 (styles.xml의 cellXfs 순서)
  const STYLE = { text: 0, head: 1, num: 2, bold: 3 };

  const xmlEsc = s => String(s)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const colName = i => { let s = ''; for (i++; i; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + (i - 1) % 26) + s; return s; };
  // 시트 이름: 31자 이내, 사용할 수 없는 문자 제거
  const sheetName = s => String(s).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31);

  function cellXml(cell, ref) {
    const c = cell !== null && typeof cell === 'object' ? cell : { v: cell };
    if (c.v === '' || c.v === null || c.v === undefined) return '';
    if (typeof c.v === 'number' && isFinite(c.v)) {
      const s = c.s === 'bold' || c.s === 'head' ? STYLE.bold : STYLE.num;
      return `<c r="${ref}" s="${s}"><v>${c.v}</v></c>`;
    }
    const s = STYLE[c.s] || STYLE.text;
    return `<c r="${ref}" t="inlineStr" s="${s}"><is><t xml:space="preserve">${xmlEsc(c.v)}</t></is></c>`;
  }

  function sheetXml(sh) {
    const cols = (sh.cols || []).map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('');
    const rows = sh.rows.map((row, r) =>
      `<row r="${r + 1}">${row.map((cell, c) => cellXml(cell, colName(c) + (r + 1))).join('')}</row>`).join('');
    return head + `<worksheet xmlns="${NS}">`
      + '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
      + (cols ? `<cols>${cols}</cols>` : '')
      + `<sheetData>${rows}</sheetData></worksheet>`;
  }

  const styles = head + `<styleSheet xmlns="${NS}">`
    + '<fonts count="2"><font><sz val="11"/><name val="맑은 고딕"/></font><font><b/><sz val="11"/><name val="맑은 고딕"/></font></fonts>'
    + '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>'
    + '<fill><patternFill patternType="solid"><fgColor rgb="FFFFE8D6"/><bgColor indexed="64"/></patternFill></fill></fills>'
    + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
    + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    + '<cellXfs count="4">'
    + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
    + '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>'
    + '<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
    + '<xf numFmtId="3" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>'
    + '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

  const files = {
    '[Content_Types].xml': head + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
      + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
      + '</Types>',
    '_rels/.rels': head + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': head + `<workbook xmlns="${NS}" xmlns:r="${REL}"><sheets>`
      + sheets.map((sh, i) => `<sheet name="${xmlEsc(sheetName(sh.name))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')
      + '</sheets></workbook>',
    'xl/_rels/workbook.xml.rels': head + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
      + `<Relationship Id="rId${sheets.length + 1}" Type="${REL}/styles" Target="styles.xml"/></Relationships>`,
    'xl/styles.xml': styles,
  };
  sheets.forEach((sh, i) => (files[`xl/worksheets/sheet${i + 1}.xml`] = sheetXml(sh)));
  return zipStore(files);
}

// 압축 없이(STORE) zip 파일을 만든다
function zipStore(files) {
  const enc = new TextEncoder();
  const crcTable = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = bytes => {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  };
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

  const locals = [], centrals = [];
  let offset = 0;
  for (const [path, text] of Object.entries(files)) {
    const name = enc.encode(path), data = enc.encode(text), crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
    lh.setUint16(8, 0, true); lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true);
    lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true);
    lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    locals.push(new Uint8Array(lh.buffer), name, data);

    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, 0, true); ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true);
    ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true);
    ch.setUint16(28, name.length, true); ch.setUint32(42, offset, true);
    centrals.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = centrals.reduce((a, b) => a + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, centrals.length / 2, true); end.setUint16(10, centrals.length / 2, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);

  const parts = [...locals, ...centrals, new Uint8Array(end.buffer)];
  const out = new Uint8Array(parts.reduce((a, b) => a + b.length, 0));
  let p = 0;
  parts.forEach(part => { out.set(part, p); p += part.length; });
  return out;
}

if (typeof module !== 'undefined') module.exports = { buildXlsx, XLSX_MIME };
