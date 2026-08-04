import NotificationsClient from './notifications-client';
import './notifications.css';
export default function NotificationsPage(){return <><div className="top"><div><h1>Notifications</h1><p>Delivery attempts, channel health, failures and controlled retries.</p></div></div><NotificationsClient/></>}
