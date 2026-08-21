'use client';
import { useAuthenticatedFetch } from '../../authenticated-api-provider';
import ErrorModal from '../../../components/error-modal';
import { useEffect,useState } from 'react';
import Link from 'next/link';
import { Bell,LoaderCircle } from 'lucide-react';
import { apiErrorMessage, notificationChannelLabel, notificationStatusLabel, notificationTemplateLabel } from '@visa-compass/shared';
const API=process.env.NEXT_PUBLIC_API_URL??'http://localhost:4000/api/v1';
type Item={id:string;orderId?:string;channel:string;template:string;status:string;createdAt:string;sentAt?:string};
export default function NotificationHistory(){const authFetch=useAuthenticatedFetch();const [items,setItems]=useState<Item[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState('');useEffect(()=>{authFetch(`${API}/customer/notifications`,{headers:{}}).then(async response=>{const value=await response.json();if(!response.ok)throw new Error(apiErrorMessage(value.error?.code??"",value.error?.message??"Something went wrong"));setItems(value.data)}).catch(cause=>setError(cause.message)).finally(()=>setLoading(false))},[]);if(loading)return <div className="account-empty compact"><LoaderCircle className="spin"/>Loading notifications…</div>;if(error)return <ErrorModal error={error} onClose={()=>setError('')}/>;if(!items.length)return <div className="account-empty"><Bell size={34}/><h2>No notifications yet</h2><p>Order review and QR-ready updates will appear here.</p></div>;return <div className="customer-notification-list">{items.map(item=><article key={item.id}><Bell size={17}/><span><b>{notificationTemplateLabel(item.template)}</b><small>{notificationChannelLabel(item.channel)} · {new Date(item.createdAt).toLocaleString()}</small></span><em>{notificationStatusLabel(item.status)}</em>{item.orderId&&<Link href={`/account/esims/${item.orderId}`}>View order</Link>}</article>)}</div>}
