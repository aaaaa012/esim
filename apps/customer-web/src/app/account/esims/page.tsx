import EsimDashboard from './esim-dashboard';
import OrderList from './esim-list';
import './esims.css';
import './account-upgrades.css';

export default function Esims(){return process.env.NEXT_PUBLIC_CUSTOMER_ESIM_PORTAL_V2==='false'?<OrderList/>:<EsimDashboard/>}
