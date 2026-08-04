import OrdersClient from '../orders/orders-client';
import '../orders/orders.css';
export default function Queue(){return <><div className="top"><div><h1>Work queue</h1><p>Orders that require an operations decision.</p></div></div><OrdersClient queueOnly/></>}
