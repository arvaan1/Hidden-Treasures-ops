// scripts/send-briefing.js
// Runs on a schedule via GitHub Actions. Reads task data from Supabase,
// composes a plain-text morning digest, and sends it to Telegram.
// Required secrets (set in GitHub: Settings -> Secrets and variables -> Actions):
//   SUPABASE_URL, SUPABASE_ANON_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

function requireEnv(){
  const missing = [];
  if (!SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!SUPABASE_ANON_KEY) missing.push('SUPABASE_ANON_KEY');
  if (!BOT_TOKEN) missing.push('TELEGRAM_BOT_TOKEN');
  if (!CHAT_ID) missing.push('TELEGRAM_CHAT_ID');
  if (missing.length) throw new Error('Missing required secrets: ' + missing.join(', '));
}

async function sbGetAll(prefix){
  const url = SUPABASE_URL + '/rest/v1/app_data?key=like.' + encodeURIComponent(prefix) + '*&select=key,value';
  const res = await fetch(url, { headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + SUPABASE_ANON_KEY } });
  if (!res.ok) throw new Error('Supabase read failed (' + res.status + '): ' + await res.text());
  return res.json();
}
async function sbGetOne(key){
  const url = SUPABASE_URL + '/rest/v1/app_data?key=eq.' + encodeURIComponent(key) + '&select=value';
  const res = await fetch(url, { headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + SUPABASE_ANON_KEY } });
  if (!res.ok) throw new Error('Supabase read failed (' + res.status + '): ' + await res.text());
  const rows = await res.json();
  return rows[0] ? rows[0].value : null;
}

function todayISO(){ return new Date().toISOString().slice(0,10); }
function fmtDateDisplay(iso){
  if (!iso) return '\u2014';
  const d = new Date(iso+'T00:00:00');
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-IN', { day:'2-digit', month:'short' });
}
function effectiveEventEnd(sheet){ return sheet.eventEnd || sheet.eventStart || ''; }
function isLiveShow(sheet){
  if (!sheet.eventStart) return false;
  const today = todayISO();
  return sheet.eventStart <= today && effectiveEventEnd(sheet) >= today;
}
function isUpcomingShow(sheet){ return !!sheet.eventStart && sheet.eventStart > todayISO(); }
function isEndedShow(sheet){
  const end = effectiveEventEnd(sheet);
  return !!end && end < todayISO();
}

function buildDigest(profiles, departments, sheets){
  const dated = sheets.filter(function(s){ return s.eventStart; });
  const live = dated.filter(isLiveShow).sort(function(a,b){ return effectiveEventEnd(a).localeCompare(effectiveEventEnd(b)); });
  const upcoming = dated.filter(isUpcomingShow).sort(function(a,b){ return a.eventStart.localeCompare(b.eventStart); });
  const placed = {}; live.concat(upcoming).forEach(function(s){ placed[s.id]=true; });
  const rest = sheets.filter(function(s){ return !placed[s.id] && !isEndedShow(s); });
  const ordered = live.concat(upcoming, rest);

  var lines = [];
  var totalPending = 0;
  var showCount = 0;

  ordered.forEach(function(sheet){
    var pending = (sheet.tasks||[]).filter(function(t){ return !t.done && t.assigneeId && profiles[t.assigneeId]; });
    if (!pending.length) return;
    showCount++;
    totalPending += pending.length;
    var status = isLiveShow(sheet) ? 'LIVE NOW' : isUpcomingShow(sheet) ? ('FROM ' + fmtDateDisplay(sheet.eventStart).toUpperCase()) : '';
    lines.push('');
    lines.push(sheet.title.toUpperCase() + (status ? '  [' + status + ']' : ''));
    lines.push('-'.repeat(Math.min(44, sheet.title.length + 4)));

    var byPerson = {};
    pending.forEach(function(t){ (byPerson[t.assigneeId] = byPerson[t.assigneeId] || []).push(t); });
    var byDept = {};
    Object.keys(byPerson).forEach(function(pid){
      var p = profiles[pid];
      var deptName = (p.departmentId && departments[p.departmentId]) ? departments[p.departmentId].name : 'No department';
      (byDept[deptName] = byDept[deptName] || []).push({ profile:p, tasks:byPerson[pid] });
    });
    Object.keys(byDept).sort().forEach(function(deptName){
      lines.push(deptName + ':');
      byDept[deptName].forEach(function(entry){
        var tasks = entry.tasks.slice().sort(function(a,b){ return (a.start||'9999').localeCompare(b.start||'9999'); });
        lines.push('  ' + entry.profile.name + ':');
        tasks.forEach(function(t){
          var dueDate = t.end || t.start;
          var overdue = !t.frequency && dueDate && dueDate < todayISO();
          var freq = t.frequency ? ' (' + t.frequency + ')' : '';
          lines.push('    - ' + fmtDateDisplay(t.start) + ' - ' + (t.text||'(untitled)') + freq + (overdue ? '  [OVERDUE]' : ''));
        });
      });
    });
  });

  if (!totalPending) return null;
  var header = 'MORNING BRIEFING\n' + totalPending + ' task' + (totalPending===1?'':'s') + ' pending across ' + showCount + ' show' + (showCount===1?'':'s');
  return header + '\n' + lines.join('\n');
}

function chunkMessage(text, maxLen){
  if (text.length <= maxLen) return [text];
  var lines = text.split('\n');
  var chunks = [], current = '';
  lines.forEach(function(line){
    if (current && (current + '\n' + line).length > maxLen){
      chunks.push(current);
      current = line;
    } else {
      current = current ? current + '\n' + line : line;
    }
  });
  if (current) chunks.push(current);
  return chunks;
}

async function sendTelegram(text){
  var url = 'https://api.telegram.org/bot' + BOT_TOKEN + '/sendMessage';
  var res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT_ID, text: text })
  });
  var data = await res.json();
  if (!data.ok) throw new Error('Telegram send failed: ' + JSON.stringify(data));
  return data;
}

async function main(){
  requireEnv();
  var metaRow = await sbGetOne('app-meta');
  var profilesRow = await sbGetOne('profiles');
  var deptsRow = await sbGetOne('departments');
  var sheetRows = await sbGetAll('sheet:');

  var profiles = profilesRow || {};
  var departments = deptsRow || {};
  var sheets = sheetRows.map(function(r){ return r.value; });

  var message = buildDigest(profiles, departments, sheets);
  if (!message){ console.log('Nothing pending today - no message sent.'); return; }

  var chunks = chunkMessage(message, 3800);
  for (var i=0; i<chunks.length; i++){ await sendTelegram(chunks[i]); }
  console.log('Briefing sent in ' + chunks.length + ' message(s).');
}

module.exports = { buildDigest, chunkMessage, isLiveShow, isUpcomingShow, isEndedShow, requireEnv, main };

if (require.main === module){
  main().catch(function(err){ console.error(err); process.exitCode = 1; });
}
