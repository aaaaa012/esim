import EsimDashboard from '../esim-dashboard';
import '../esims.css';
import './details.css';
export default async function Page({params}:{params:Promise<{id:string}>}){return <EsimDashboard selectedId={(await params).id}/>}
