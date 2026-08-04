'use client';
import { useAuthenticatedFetch } from '../authenticated-api-provider';
import { useEffect,useState } from 'react';
import { AlertTriangle,CheckCircle2,LoaderCircle,PackageCheck,PackageOpen,RefreshCcw } from 'lucide-react';
const API=process.env.NEXT_PUBLIC_API_URL??'http://localhost:4000/api/v1';
type Overview={counts:{available:number;reserved:number;assigned:number;activated:number};lowStockThreshold:number;lowStock:boolean;batches:{id:string;batchReference:string;totalProfiles:number;importedCount:number;failedCount:number;createdAt:string}[]};

export default function InventoryClient(){const authFetch=useAuthenticatedFetch();
  const [data,setData]=useState<Overview|null>(null),[error,setError]=useState('');
  useEffect(()=>{void authFetch(`${API}/operations/inventory`,{headers:{}}).then(async r=>{const v=await r.json();if(!r.ok)throw new Error(v.error?.message);setData(v.data)}).catch(e=>setError(e.message))},[]);
  if(!data)return <div className="empty-table">{error||<><LoaderCircle className="spin"/>Loading inventory…</>}</div>;
  const metrics=[['Available',data.counts.available,PackageOpen],['Reserved',data.counts.reserved,RefreshCcw],['Assigned',data.counts.assigned,PackageCheck],['Activated',data.counts.activated,CheckCircle2]] as const;
  return <><div className="top"><div><h1>eSIM inventory</h1><p>Atomic reservations, single-use assignment, and batch traceability.</p></div><span className={`stock-state ${data.lowStock?'low':'healthy'}`}>{data.lowStock?<AlertTriangle size={15}/>:<CheckCircle2 size={15}/>} {data.lowStock?'Low stock':'Stock healthy'}</span></div><section className="grid">{metrics.map(([label,value,Icon])=><article className="metric" key={label}><span className="metric-label">{label}</span><div className="metric-row"><strong>{value}</strong><span className="icon"><Icon size={18}/></span></div></article>)}</section><div className="threshold-note">Low-stock alert triggers at {data.lowStockThreshold} available profiles.</div><section className="panel"><div className="panel-head"><h2>Import batches</h2><span>{data.batches.length} batches</span></div>{data.batches.length===0?<div className="empty-table">No inventory batches imported yet.</div>:<div className="table-wrap"><table><thead><tr><th>Batch</th><th>Imported</th><th>Failed</th><th>Total</th><th>Created</th></tr></thead><tbody>{data.batches.map(batch=><tr key={batch.id}><td><b>{batch.batchReference}</b></td><td>{batch.importedCount}</td><td>{batch.failedCount}</td><td>{batch.totalProfiles}</td><td>{new Date(batch.createdAt).toLocaleString()}</td></tr>)}</tbody></table></div>}</section></>;
}
