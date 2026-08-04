import EsimDetails from './esim-details';
import '../esims.css';
import './details.css';
export default async function Page({params}:{params:Promise<{id:string}>}){return <EsimDetails id={(await params).id}/>}
