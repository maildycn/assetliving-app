// ============================================================
//  AssetLiving — Google Calendar Auto Sync
//  วางโค้ดนี้ใน script.google.com แล้วทำตามขั้นตอน Setup ด้านล่าง
// ============================================================

// ── Config ────────────────────────────────────────────────────────────────────
const NOTION_TOKEN  = PropertiesService.getScriptProperties().getProperty('NOTION_TOKEN');
const LEASE_DB_ID   = '0d3ce732aec048f298c93baa788b5306';
const CALENDAR_ID   = 'primary'; // เปลี่ยนเป็น calendar ID ถ้าไม่ใช้ primary
const EVENT_ID_PROP = 'Google Cal Event ID'; // ชื่อ property ใน Notion สำหรับเก็บ event ID

// ── Main Sync (รันรายวันอัตโนมัติ) ───────────────────────────────────────────
function syncCalendar() {
  const cal = CALENDAR_ID === 'primary'
    ? CalendarApp.getDefaultCalendar()
    : CalendarApp.getCalendarById(CALENDAR_ID);

  const contracts = fetchNotionContracts();
  let created = 0, deleted = 0, skipped = 0;

  for (const c of contracts) {
    if (!c.endDate) { skipped++; continue; }

    const expired = new Date(c.endDate) < new Date();

    if (expired && c.eventId) {
      // สัญญาหมดอายุ + มี event → ลบออก
      try {
        const ev = cal.getEventById(c.eventId);
        if (ev) ev.deleteEvent();
        notionPatchEventId(c.pageId, '');
        deleted++;
        Logger.log(`Deleted: ${c.tenant} (${c.endDate})`);
      } catch (e) {
        Logger.log(`Delete failed [${c.tenant}]: ${e}`);
      }

    } else if (!expired && !c.eventId) {
      // สัญญายังใช้งาน + ยังไม่มี event → สร้างใหม่
      try {
        const endDate = new Date(c.endDate);
        const title = 'สัญญาหมด: ' + c.tenant + ' - ' + c.property;
        const desc  = [
          'ผู้เช่า: ' + c.tenant,
          'ห้อง: ' + c.property,
          c.rent    ? 'ค่าเช่า: ' + c.rent + '/เดือน' : null,
          c.deposit ? 'เงินมัดจำ: ' + c.deposit        : null,
          c.phone   ? 'โทร: ' + c.phone                : null,
          'วันเริ่ม: ' + (c.startDate || '-'),
        ].filter(Boolean).join('\n');

        const ev = cal.createAllDayEvent(title, endDate, { description: desc });
        Logger.log('Event created: ' + c.tenant);

        try { ev.addPopupReminder(40320); } catch(e2) { Logger.log('reminder 40320 failed: ' + e2); }
        try { ev.addPopupReminder(1440);  } catch(e2) { Logger.log('reminder 1440 failed: ' + e2); }
        try { ev.addPopupReminder(480);   } catch(e2) { Logger.log('reminder 480 failed: ' + e2); }

        notionPatchEventId(c.pageId, ev.getId());
        created++;
      } catch (e) {
        Logger.log('Create failed [' + c.tenant + ']: ' + e);
      }
    }
  }

  Logger.log(`Sync done — created: ${created}, deleted: ${deleted}, skipped/no-date: ${skipped}, total: ${contracts.length}`);
}

// ── ดึงสัญญาทั้งหมดจาก Notion ────────────────────────────────────────────────
function fetchNotionContracts() {
  const contracts = [];
  let cursor = null;

  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;

    const res = UrlFetchApp.fetch(
      `https://api.notion.com/v1/databases/${LEASE_DB_ID}/query`,
      {
        method: 'post',
        headers: {
          'Authorization': 'Bearer ' + NOTION_TOKEN,
          'Notion-Version': '2022-06-28',
          'Content-Type': 'application/json',
        },
        payload: JSON.stringify(body),
        muteHttpExceptions: true,
      }
    );

    const data = JSON.parse(res.getContentText());
    if (!data.results) {
      Logger.log('Notion error: ' + res.getContentText());
      break;
    }

    for (const p of data.results) {
      contracts.push({
        pageId:    p.id,
        tenant:    getTitleText(p) || '—',
        property:  p.properties['ทรัพย์สิน / ห้อง']?.rich_text?.[0]?.plain_text || '—',
        rent:      p.properties['ค่าเช่า (บาท/เดือน)']?.number ?? null,
        deposit:   p.properties['เงินมัดจำ (บาท)']?.number ?? null,
        phone:     p.properties['เบอร์โทรผู้เช่า']?.phone_number || null,
        startDate: p.properties['วันเริ่มสัญญา']?.date?.start || null,
        endDate:   p.properties['วันหมดสัญญา']?.date?.start || null,
        eventId:   p.properties[EVENT_ID_PROP]?.rich_text?.[0]?.plain_text || null,
      });
    }

    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);

  return contracts;
}

// ── บันทึก/ล้าง event ID ใน Notion ──────────────────────────────────────────
function notionPatchEventId(pageId, eventId) {
  const props = {};
  props[EVENT_ID_PROP] = eventId
    ? { rich_text: [{ text: { content: eventId } }] }
    : { rich_text: [] };

  UrlFetchApp.fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: 'patch',
    headers: {
      'Authorization': 'Bearer ' + NOTION_TOKEN,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    payload: JSON.stringify({ properties: props }),
    muteHttpExceptions: true,
  });
}

// ── Helper ────────────────────────────────────────────────────────────────────
function getTitleText(page) {
  for (const val of Object.values(page.properties || {})) {
    if (val.type === 'title' && val.title?.length) return val.title[0].plain_text;
  }
  return '';
}

// ── Setup (รันครั้งเดียวเพื่อสร้าง property ใน Notion) ───────────────────────
function setup() {
  const res = UrlFetchApp.fetch(
    `https://api.notion.com/v1/databases/${LEASE_DB_ID}`,
    {
      method: 'patch',
      headers: {
        'Authorization': 'Bearer ' + NOTION_TOKEN,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      },
      payload: JSON.stringify({
        properties: {
          [EVENT_ID_PROP]: { rich_text: {} }
        }
      }),
      muteHttpExceptions: true,
    }
  );
  const data = JSON.parse(res.getContentText());
  if (data.id) {
    Logger.log('Setup OK');
  } else {
    Logger.log('Setup failed: ' + res.getContentText());
  }
}

// ── ทดสอบสิทธิ์ Calendar (รันครั้งเดียวก่อน syncCalendar) ────────────────────
function authCalendar() {
  const cal = CalendarApp.getDefaultCalendar();
  const d = new Date();
  d.setDate(d.getDate() + 365);
  const ev = cal.createAllDayEvent('AssetLiving Test', d);
  ev.deleteEvent();
  Logger.log('Calendar write OK');
}

// ── Debug: ทดสอบสร้าง event จริงแบบที่ syncCalendar ทำ ──────────────────────
function debugSync() {
  const cal = CalendarApp.getDefaultCalendar();
  const d = new Date('2027-01-31');
  Logger.log('date: ' + d);
  try {
    const ev = cal.createAllDayEvent('Test Tenant - Room 101', d, { description: 'test desc' });
    Logger.log('created: ' + ev.getId());
    try { ev.addPopupReminder(40320); Logger.log('reminder OK'); } catch(e) { Logger.log('reminder failed: ' + e); }
    ev.deleteEvent();
    Logger.log('Done OK');
  } catch(e) {
    Logger.log('FAILED: ' + e);
  }
}
