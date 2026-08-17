/** Easy - Bubble API
 * ผูกไฟล์นี้กับ Google Sheet แล้วรัน setupSystem() หนึ่งครั้งก่อน Deploy เป็น Web app
 */
const TZ = 'Asia/Bangkok';
const SHEETS = {
  staff: ['staff_id','name','nickname','pin','role','branch_id','daily_rate','ot_rate','status','created_at','shift_id'],
  branches: ['branch_id','name','lat','lng','allowed_radius_m','status'],
  shifts: ['shift_id','name','start_time','end_time','late_grace_min','ot_grace_min','status','created_at'],
  timesheets: ['record_id','staff_id','staff_name','branch_id','branch_name','date','clock_in','clock_out','hours_worked','late_min','ot_hours','ot_status','note','clock_in_lat','clock_in_lng','clock_out_lat','clock_out_lng','created_at','shift_id','shift_name','shift_start','shift_end','late_grace_min','ot_grace_min'],
  leaves: ['leave_id','staff_id','date_from','date_to','leave_type','note','status','created_at'],
  advances: ['advance_id','staff_id','amount','date','note','status','deducted_month','created_at'],
  payroll_runs: ['run_id','month','staff_id','staff_name','days_worked','paid_leave_days','base_pay','ot_pay','late_deduct','advance_deduct','manual_adjust','total_pay','status','paid_at'],
  settings: ['key','value','description']
};

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Easy - Bubble').addItem('สร้าง/ซ่อมโครงสร้างระบบ','setupSystem').addToUi();
}

function setupSystem() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  PropertiesService.getScriptProperties().setProperty('SHEET_ID', ss.getId());
  Object.keys(SHEETS).forEach(name => ensureSheet_(name, SHEETS[name]));
  const settings = sheetObjects_('settings');
  const defaults = [
    ['shop_name','Easy - Bubble','ชื่อร้าน'],['shift_start','09:00','เวลาเริ่มงาน'],['shift_end','18:00','เวลาเลิกงาน'],
    ['late_grace_min','15','อนุโลมสาย (นาที)'],['ot_grace_min','15','เริ่มนับ OT หลังเลิกงาน (นาที)'],
    ['late_deduct_mode','per_minute','วิธีหักมาสาย'],['telegram_chat_id','','Telegram Chat ID']
  ];
  defaults.filter(x => !settings.some(s => s.key === x[0])).forEach(x => append_('settings',{key:x[0],value:x[1],description:x[2]}));
  if (!sheetObjects_('shifts').length) {
    append_('shifts',{shift_id:'SH001',name:'กะหลัก',start_time:'09:00',end_time:'18:00',late_grace_min:15,ot_grace_min:15,status:'active',created_at:iso_()});
  }
  if (!sheetObjects_('branches').length) {
    append_('branches',{branch_id:'BR001',name:'วังหิน',allowed_radius_m:200,status:'active'});
    append_('branches',{branch_id:'BR002',name:'สะพานใหม่',allowed_radius_m:200,status:'active'});
  }
  if (!sheetObjects_('staff').length) {
    const pin = String(Math.floor(1000 + Math.random() * 9000));
    append_('staff',{staff_id:'STF001',name:'ผู้ดูแลระบบ',nickname:'แอดมิน',pin,role:'admin',branch_id:'BR001',daily_rate:0,ot_rate:0,status:'active',created_at:iso_(),shift_id:'SH001'});
    console.log('รหัส PIN แอดมินครั้งแรก: ' + pin);
    SpreadsheetApp.getUi().alert('ตั้งค่าระบบเรียบร้อย\nPIN แอดมินครั้งแรก: ' + pin + '\nกรุณาจดไว้และเปลี่ยนจากหน้าเว็บหลังเข้าสู่ระบบ');
  } else {
    const firstShift=(sheetObjects_('shifts').find(x=>x.status==='active')||{}).shift_id||'SH001';
    sheetObjects_('staff').filter(x=>!x.shift_id).forEach(x=>updateById_('staff','staff_id',x.staff_id,{shift_id:firstShift}));
    SpreadsheetApp.getUi().alert('ตรวจสอบโครงสร้างระบบเรียบร้อย');
  }
}

function doGet(e) { return route_(e && e.parameter ? e.parameter : {}); }
function doPost(e) {
  let body = {};
  try { body = JSON.parse(e.postData.contents || '{}'); } catch (_) { return json_({success:false,message:'ข้อมูลไม่ถูกต้อง'}); }
  return route_(body);
}

function route_(b) {
  try {
    let data;
    if (b.action === 'login') data = login_(b.pin);
    else {
      const user = session_(b.token);
      if (!user) throw Error('เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่');
      const adminOnly = ['adminData','saveStaff','saveBranch','saveShift','saveSettings','saveTelegram','bulkUpsertTimesheets','saveLeave','saveAdvance','approveOT','payrollPreview','finalizePayroll'];
      if (adminOnly.includes(b.action) && user.role !== 'admin') throw Error('ไม่มีสิทธิ์ทำรายการนี้');
      switch (b.action) {
        case 'myDashboard': data = myDashboard_(user); break;
        case 'clockIn': data = clockIn_(user,b); break;
        case 'clockOut': data = clockOut_(user,b); break;
        case 'adminData': data = adminData_(); break;
        case 'saveStaff': data = saveStaff_(b); break;
        case 'saveBranch': data = saveBranch_(b); break;
        case 'saveShift': data = saveShift_(b); break;
        case 'saveSettings': data = saveSettings_(b.settings||{}); break;
        case 'saveTelegram': data = saveTelegram_(b); break;
        case 'bulkUpsertTimesheets': data = bulkUpsert_(b); break;
        case 'saveLeave': data = saveLeave_(b); break;
        case 'saveAdvance': data = saveAdvance_(b); break;
        case 'approveOT': data = approveOT_(b); break;
        case 'payrollPreview': data = payrollPreview_(b.month); break;
        case 'finalizePayroll': data = finalizePayroll_(b); break;
        default: throw Error('ไม่พบคำสั่งที่ร้องขอ');
      }
    }
    return json_({success:true,data});
  } catch (err) { return json_({success:false,message:err.message||String(err)}); }
}

function login_(pin) {
  const staff = sheetObjects_('staff').find(x => String(x.pin).trim() === String(pin||'').trim() && x.status === 'active');
  if (!staff) throw Error('PIN ไม่ถูกต้อง');
  const branch = sheetObjects_('branches').find(x => x.branch_id === staff.branch_id);
  const token = Utilities.getUuid() + Utilities.getUuid();
  const safe = {...staff,branch_name:branch?branch.name:'',token,expires:Date.now()+21600000}; delete safe.pin;
  CacheService.getScriptCache().put('session:'+token,JSON.stringify(safe),21600);
  return safe;
}
function session_(token) { try { const x=CacheService.getScriptCache().get('session:'+token); return x?JSON.parse(x):null; } catch(_){return null} }

function clockIn_(user,b) {
  const today = date_(), rows=sheetObjects_('timesheets');
  if (rows.some(x=>x.staff_id===user.staff_id&&x.date===today&&x.clock_in)) throw Error('วันนี้บันทึกเข้างานแล้ว');
  const branch = nearestBranch_(Number(b.lat),Number(b.lng));
  const staff=sheetObjects_('staff').find(x=>x.staff_id===user.staff_id)||user,shift=shiftForStaff_(staff),now=time_(),late=lateMinutes_(now,shift.start_time);
  const row={record_id:id_('TS'),staff_id:user.staff_id,staff_name:user.nickname||user.name,branch_id:branch.branch_id,branch_name:branch.name,date:today,clock_in:now,clock_out:'',hours_worked:'',late_min:late,ot_hours:0,ot_status:'none',note:'',clock_in_lat:b.lat,clock_in_lng:b.lng,created_at:iso_(),shift_id:shift.shift_id,shift_name:shift.name,shift_start:shift.start_time,shift_end:shift.end_time,late_grace_min:shift.late_grace_min,ot_grace_min:shift.ot_grace_min};
  append_('timesheets',row); telegram_(`✅ ${row.staff_name} เข้างาน ${now}\n🕒 ${shift.name} (${shift.start_time}–${shift.end_time})\n📍 ${branch.name}${late>Number(shift.late_grace_min||0)?`\n⚠️ สาย ${late} นาที`:''}`); return row;
}
function clockOut_(user,b) {
  const today=date_(),yesterday=date_(new Date(Date.now()-86400000));
  const row=sheetObjects_('timesheets').find(x=>x.staff_id===user.staff_id&&!x.clock_out&&(x.date===today||x.date===yesterday));
  if(!row) throw Error('ไม่พบรายการเข้างานที่ยังไม่ได้ออก');
  const branch=nearestBranch_(Number(b.lat),Number(b.lng)), now=time_(), shift=shiftForTimesheet_(row);
  const hours=hours_(row.clock_in,now),otMin=overtimeMinutes_(row.clock_in,shift.end_time,now);
  const otHours=otMin>Number(shift.ot_grace_min||0)?Number((otMin/60).toFixed(2)):0;
  updateById_('timesheets','record_id',row.record_id,{clock_out:now,hours_worked:hours,ot_hours:otHours,ot_status:otHours?'pending':'none',clock_out_lat:b.lat,clock_out_lng:b.lng});
  telegram_(`🚪 ${user.nickname||user.name} ออกงาน ${now}\n📍 ${branch.name}${otHours?`\n⏰ OT รอตรวจ ${otHours} ชม.`:''}`); return {clock_out:now,hours_worked:hours,ot_hours:otHours};
}
function myDashboard_(user) {
  const rows=sheetObjects_('timesheets').filter(x=>x.staff_id===user.staff_id).sort((a,b)=>String(b.date).localeCompare(String(a.date)));
  const staff=sheetObjects_('staff').find(x=>x.staff_id===user.staff_id)||user;
  return {today:rows.find(x=>x.date===date_())||null,history:rows.slice(0,7),shift:shiftForStaff_(staff)};
}

function adminData_() {
  const staff=sheetObjects_('staff'),branches=sheetObjects_('branches'),shifts=sheetObjects_('shifts'),times=sheetObjects_('timesheets'),today=date_();
  const withBranch=staff.map(s=>({...s,branch_name:(branches.find(b=>b.branch_id===s.branch_id)||{}).name||'',shift_name:(shifts.find(x=>x.shift_id===s.shift_id)||{}).name||''}));
  const ot=times.filter(x=>x.ot_status==='pending');
  return {staff:withBranch,branches,shifts,settings:settings_(),overview:{active_staff:staff.filter(x=>x.status==='active'&&x.role!=='admin').length,present_today:times.filter(x=>x.date===today&&x.clock_in).length,pending_ot:ot.length,today:times.filter(x=>x.date===today),ot_items:ot}};
}
function saveStaff_(b) {
  if(!/^\d{4}$/.test(String(b.pin||''))) throw Error('PIN ต้องเป็นตัวเลข 4 หลัก');
  const rows=sheetObjects_('staff'); if(rows.some(x=>String(x.pin)===String(b.pin)&&x.staff_id!==b.staff_id)) throw Error('PIN นี้มีคนใช้อยู่แล้ว');
  if(!sheetObjects_('shifts').some(x=>x.shift_id===b.shift_id))throw Error('กรุณาเลือกกะประจำ');
  const data={name:b.name,nickname:b.nickname,pin:String(b.pin),role:b.role||'staff',branch_id:b.branch_id,daily_rate:Number(b.daily_rate||0),ot_rate:Number(b.ot_rate||0),status:b.status||'active',shift_id:b.shift_id};
  if(b.staff_id){updateById_('staff','staff_id',b.staff_id,data);return {staff_id:b.staff_id}}
  data.staff_id=nextId_('staff','staff_id','STF');data.created_at=iso_();append_('staff',data);return {staff_id:data.staff_id};
}
function saveShift_(b) {
  if(!String(b.name||'').trim())throw Error('กรุณาตั้งชื่อกะ');
  if(!/^\d{2}:\d{2}$/.test(b.start_time||'')||!/^\d{2}:\d{2}$/.test(b.end_time||''))throw Error('กรุณากรอกเวลาเริ่มและเลิกงาน');
  const data={name:String(b.name).trim(),start_time:b.start_time,end_time:b.end_time,late_grace_min:Math.max(0,Number(b.late_grace_min||0)),ot_grace_min:Math.max(0,Number(b.ot_grace_min||0)),status:b.status||'active'};
  if(b.shift_id){updateById_('shifts','shift_id',b.shift_id,data);return {shift_id:b.shift_id}}
  data.shift_id=nextId_('shifts','shift_id','SH');data.created_at=iso_();append_('shifts',data);return {shift_id:data.shift_id};
}
function saveBranch_(b) {
  const data={name:b.name,lat:Number(b.lat),lng:Number(b.lng),allowed_radius_m:Number(b.allowed_radius_m||200),status:'active'};
  if(!isFinite(data.lat)||!isFinite(data.lng)) throw Error('กรุณาบันทึกพิกัดสาขา');
  if(b.branch_id){updateById_('branches','branch_id',b.branch_id,data);return {branch_id:b.branch_id}}
  data.branch_id=nextId_('branches','branch_id','BR');append_('branches',data);return {branch_id:data.branch_id};
}
function saveSettings_(obj){Object.entries(obj).forEach(([key,value])=>upsertSetting_(key,value));return settings_()}
function saveTelegram_(b){if(b.token)PropertiesService.getScriptProperties().setProperty('TELEGRAM_BOT_TOKEN',String(b.token).trim());if(b.chat_id!==undefined)upsertSetting_('telegram_chat_id',b.chat_id);telegram_('🔔 เชื่อมต่อการแจ้งเตือน Easy - Bubble เรียบร้อย');return true}

function bulkUpsert_(b){
  if(!b.staff_id||!b.date_from||!b.date_to||!b.clock_in||!b.clock_out||!b.admin_note)throw Error('กรุณากรอกข้อมูลให้ครบ');
  const staff=sheetObjects_('staff').find(x=>x.staff_id===b.staff_id);if(!staff)throw Error('ไม่พบพนักงาน');
  const shift=shiftById_(b.shift_id||staff.shift_id);
  const branch=sheetObjects_('branches').find(x=>x.branch_id===staff.branch_id)||{},existing=sheetObjects_('timesheets'),skip=b.skip_dates||[];let created=0,skipped=0;
  for(let d=new Date(b.date_from+'T00:00:00');d<=new Date(b.date_to+'T00:00:00');d.setDate(d.getDate()+1)){
    const ds=Utilities.formatDate(d,TZ,'yyyy-MM-dd');if(skip.includes(ds)||existing.some(x=>x.staff_id===staff.staff_id&&x.date===ds)){skipped++;continue}
    const otMin=overtimeMinutes_(b.clock_in,shift.end_time,b.clock_out),otHours=otMin>Number(shift.ot_grace_min||0)?Number((otMin/60).toFixed(2)):0;
    append_('timesheets',{record_id:id_('TS'),staff_id:staff.staff_id,staff_name:staff.nickname||staff.name,branch_id:staff.branch_id,branch_name:branch.name||'',date:ds,clock_in:b.clock_in,clock_out:b.clock_out,hours_worked:hours_(b.clock_in,b.clock_out),late_min:lateMinutes_(b.clock_in,shift.start_time),ot_hours:otHours,ot_status:otHours?'pending':'none',note:'เพิ่มย้อนหลังโดยแอดมิน: '+b.admin_note,created_at:iso_(),shift_id:shift.shift_id,shift_name:shift.name,shift_start:shift.start_time,shift_end:shift.end_time,late_grace_min:shift.late_grace_min,ot_grace_min:shift.ot_grace_min});created++;
  } return {created,skipped};
}
function saveLeave_(b){if(!b.staff_id||!b.date_from||!b.date_to)throw Error('กรุณากรอกข้อมูลให้ครบ');const id=id_('LV');append_('leaves',{leave_id:id,staff_id:b.staff_id,date_from:b.date_from,date_to:b.date_to,leave_type:b.leave_type,note:b.note||'',status:'approved',created_at:iso_()});return {leave_id:id}}
function saveAdvance_(b){if(!b.staff_id||Number(b.amount)<=0)throw Error('กรุณากรอกจำนวนเงิน');const id=id_('ADV');append_('advances',{advance_id:id,staff_id:b.staff_id,amount:Number(b.amount),date:date_(),note:b.note||'',status:'pending',deducted_month:'',created_at:iso_()});return {advance_id:id}}
function approveOT_(b){if(!['approved','rejected'].includes(b.status))throw Error('สถานะไม่ถูกต้อง');if(!updateById_('timesheets','record_id',b.record_id,{ot_status:b.status}))throw Error('ไม่พบรายการ');return true}

function payrollPreview_(month){
  if(!/^\d{4}-\d{2}$/.test(month||''))throw Error('กรุณาเลือกเดือน');const settings=settings_();
  const staff=sheetObjects_('staff').filter(x=>x.status==='active'&&x.role!=='admin'),times=sheetObjects_('timesheets').filter(x=>String(x.date).startsWith(month)),leaves=sheetObjects_('leaves'),adv=sheetObjects_('advances').filter(x=>x.status==='pending');
  return staff.map(s=>{const t=times.filter(x=>x.staff_id===s.staff_id),days=new Set(t.filter(x=>x.clock_in).map(x=>x.date)).size,paidLeave=countPaidLeaveDays_(leaves.filter(x=>x.staff_id===s.staff_id&&x.status==='approved'),month),rate=Number(s.daily_rate||0),otHours=t.filter(x=>x.ot_status==='approved').reduce((a,x)=>a+Number(x.ot_hours||0),0),lateDeduct=settings.late_deduct_mode==='none'?0:t.reduce((a,x)=>{const sh=shiftForTimesheet_(x),late=Math.max(0,Number(x.late_min||0)-Number(sh.late_grace_min||0)),mins=Math.max(1,minutesOvernight_(sh.start_time,sh.end_time));return a+(rate/mins*late)},0),advance=adv.filter(x=>x.staff_id===s.staff_id).reduce((a,x)=>a+Number(x.amount||0),0),base=rate*(days+paidLeave),ot=otHours*Number(s.ot_rate||0);return{staff_id:s.staff_id,staff_name:s.nickname||s.name,days_worked:days,paid_leave_days:paidLeave,base_pay:round_(base),ot_pay:round_(ot),late_deduct:round_(lateDeduct),advance_deduct:round_(advance),manual_adjust:0,total_pay:round_(base+ot-lateDeduct-advance)}});
}
function finalizePayroll_(b){const items=b.items||[];if(!items.length)throw Error('ไม่พบข้อมูลเงินเดือน');const existing=sheetObjects_('payroll_runs');items.forEach(x=>{if(existing.some(r=>r.month===b.month&&r.staff_id===x.staff_id))return;append_('payroll_runs',{run_id:id_('PR'),month:b.month,...x,status:'paid',paid_at:iso_()})});const sheet=sheet_('advances'),rows=sheetObjects_('advances');rows.filter(x=>x.status==='pending').forEach(x=>updateById_('advances','advance_id',x.advance_id,{status:'deducted',deducted_month:b.month}));telegram_(`💰 บันทึกจ่ายเงินเดือน Easy - Bubble รอบ ${b.month} แล้ว\nพนักงาน ${items.length} คน\nรวม ฿${items.reduce((a,x)=>a+Number(x.total_pay||0),0).toLocaleString('th-TH')}`);return true}

function countPaidLeaveDays_(rows,month){let dates=new Set();rows.filter(x=>x.leave_type!=='unpaid').forEach(x=>{for(let d=new Date(x.date_from+'T00:00:00');d<=new Date(x.date_to+'T00:00:00');d.setDate(d.getDate()+1)){const ds=Utilities.formatDate(d,TZ,'yyyy-MM-dd');if(ds.startsWith(month))dates.add(ds)}});return dates.size}
function nearestBranch_(lat,lng){if(!isFinite(lat)||!isFinite(lng))throw Error('ไม่พบข้อมูล GPS');let best=null,dist=Infinity;sheetObjects_('branches').filter(x=>x.status==='active'&&x.lat&&x.lng).forEach(x=>{const d=haversine_(lat,lng,Number(x.lat),Number(x.lng));if(d<=Number(x.allowed_radius_m||200)&&d<dist){best=x;dist=d}});if(!best)throw Error('อยู่นอกพื้นที่สาขา ไม่สามารถบันทึกเวลาได้');return best}
function telegram_(text){try{const token=PropertiesService.getScriptProperties().getProperty('TELEGRAM_BOT_TOKEN'),chat=settings_().telegram_chat_id;if(!token||!chat)return;UrlFetchApp.fetch(`https://api.telegram.org/bot${token}/sendMessage`,{method:'post',contentType:'application/json',payload:JSON.stringify({chat_id:chat,text}),muteHttpExceptions:true})}catch(e){console.log(e)}}
function settings_(){const out={};sheetObjects_('settings').forEach(x=>out[x.key]=String(x.value));return out}
function shiftById_(id){const shifts=sheetObjects_('shifts'),shift=shifts.find(x=>x.shift_id===id)||shifts.find(x=>x.status==='active');if(!shift)throw Error('ยังไม่ได้ตั้งค่ากะงาน');return shift}
function shiftForStaff_(staff){return shiftById_(staff.shift_id)}
function shiftForTimesheet_(row){if(row.shift_start&&row.shift_end)return{shift_id:row.shift_id||'',name:row.shift_name||'กะเดิม',start_time:row.shift_start,end_time:row.shift_end,late_grace_min:Number(row.late_grace_min||0),ot_grace_min:Number(row.ot_grace_min||0)};const settings=settings_();try{return shiftById_(row.shift_id)}catch(_){return{shift_id:'',name:'กะเดิม',start_time:settings.shift_start||'09:00',end_time:settings.shift_end||'18:00',late_grace_min:Number(settings.late_grace_min||0),ot_grace_min:Number(settings.ot_grace_min||0)}}}
function upsertSetting_(key,value){const rows=sheetObjects_('settings'),x=rows.find(r=>r.key===key);if(x)updateById_('settings','key',key,{value});else append_('settings',{key,value,description:''})}
function ss_(){const id=PropertiesService.getScriptProperties().getProperty('SHEET_ID');return id?SpreadsheetApp.openById(id):SpreadsheetApp.getActiveSpreadsheet()}
function sheet_(name){const s=ss_().getSheetByName(name);if(!s)throw Error('ไม่พบชีต '+name);return s}
function ensureSheet_(name,headers){const ss=SpreadsheetApp.getActiveSpreadsheet();let s=ss.getSheetByName(name);if(!s)s=ss.insertSheet(name);if(s.getLastRow()===0){s.getRange(1,1,1,headers.length).setValues([headers]).setFontWeight('bold').setBackground('#dceff7')}else{const existing=s.getRange(1,1,1,s.getLastColumn()).getValues()[0];headers.filter(h=>!existing.includes(h)).forEach(h=>{const c=s.getLastColumn()+1;s.getRange(1,c).setValue(h).setFontWeight('bold').setBackground('#dceff7')})}s.setFrozenRows(1);return s}
function sheetObjects_(name){const s=sheet_(name),values=s.getDataRange().getDisplayValues();if(values.length<2)return[];const h=values[0];return values.slice(1).filter(r=>r.some(Boolean)).map(r=>Object.fromEntries(h.map((k,i)=>[k,r[i]])))}
function append_(name,obj){const s=sheet_(name),h=s.getRange(1,1,1,s.getLastColumn()).getValues()[0];s.appendRow(h.map(k=>obj[k]!==undefined?obj[k]:''))}
function updateById_(name,idCol,id,updates){const s=sheet_(name),v=s.getDataRange().getValues(),h=v[0],idx=h.indexOf(idCol);for(let r=1;r<v.length;r++)if(String(v[r][idx])===String(id)){Object.entries(updates).forEach(([k,val])=>{const c=h.indexOf(k);if(c>=0)s.getRange(r+1,c+1).setValue(val)});return true}return false}
function nextId_(name,col,prefix){const nums=sheetObjects_(name).map(x=>Number(String(x[col]).replace(/\D/g,''))||0);return prefix+String(Math.max(0,...nums)+1).padStart(3,'0')}
function id_(p){return p+Utilities.formatDate(new Date(),TZ,'yyyyMMddHHmmss')+String(Math.floor(Math.random()*90+10))}
function date_(d=new Date()){return Utilities.formatDate(d,TZ,'yyyy-MM-dd')}function time_(){return Utilities.formatDate(new Date(),TZ,'HH:mm')}function iso_(){return new Date().toISOString()}
function minutes_(t){const [h,m]=String(t).split(':').map(Number);return h*60+m}function minutesOvernight_(start,end){let a=minutes_(start),b=minutes_(end);if(b<a)b+=1440;return b-a}function lateMinutes_(actual,start){let d=minutes_(actual)-minutes_(start);if(d<-720)d+=1440;return Math.max(0,d)}function hours_(a,b){return Number((minutesOvernight_(a,b)/60).toFixed(2))}function round_(n){return Math.round((Number(n)||0)*100)/100}
function overtimeMinutes_(clockIn,shiftEnd,clockOut){const start=minutes_(clockIn);let end=minutes_(shiftEnd),out=minutes_(clockOut);if(end<=start)end+=1440;if(out<start)out+=1440;return Math.max(0,out-end)}
function haversine_(a,b,c,d){const R=6371000,p=x=>x*Math.PI/180,da=p(c-a),db=p(d-b),q=Math.sin(da/2)**2+Math.cos(p(a))*Math.cos(p(c))*Math.sin(db/2)**2;return 2*R*Math.atan2(Math.sqrt(q),Math.sqrt(1-q))}
function json_(obj){return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON)}
