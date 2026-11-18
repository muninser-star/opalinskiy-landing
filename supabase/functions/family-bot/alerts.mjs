import {oneLine} from './core.mjs';
export const POLZA_THRESHOLD=70;
const DAY=86400000;
export function polzaAmount(snapshot){
  const source=snapshot.tiles?.find(t=>t.kind==='polza')?.result;
  const amount=source?.data?.amount;
  return source?.state==='ok'&&typeof amount==='number'&&Number.isFinite(amount)?amount:null;
}
export function proxyAlerts(snapshot,now,owner){
  const source=snapshot.tiles?.find(t=>t.kind==='proxy')?.result;
  if(source?.state!=='ok'||!Array.isArray(source.data?.orders))return [];
  const alerts=[],seen=new Set();
  for(const order of source.data.orders){
    const expires=Date.parse(order.expires_at),left=expires-+new Date(now);
    if(!Number.isFinite(expires)||left<=0||left>3*DAY)continue;
    const stage=left<=DAY?1:3,id=oneLine(order.id,120);
    if(!id)continue;
    const key='alert:proxy:'+owner+':'+id+':'+expires+':'+stage;
    if(seen.has(key))continue;seen.add(key);
    const when=new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',day:'numeric',month:'long',hour:'2-digit',minute:'2-digit'}).format(new Date(expires));
    alerts.push({key,kind:'proxy',text:'Срочно · срок прокси\n\n'+(oneLine(order.country,40)||'Прокси')+' отключится '+when+' МСК.\nДо окончания '+(stage===1?'не больше 1 дня':'не больше 3 дней')+'.\nhttps://dash.opalinskiy.ru/'});
  }
  return alerts;
}
