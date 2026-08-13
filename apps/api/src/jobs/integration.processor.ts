import { Injectable, OnModuleInit } from '@nestjs/common';
import type { Job } from 'bullmq';
import QRCode from 'qrcode';
import { PrismaService } from '../infrastructure/prisma.service.js';
import { OrdersService } from '../modules/orders/orders.service.js';
import { ConnectivityService } from '../modules/integration/connectivity.service.js';
import { PaymentsService } from '../modules/payments/payments.service.js';
import { GmailChannel } from '../modules/notification/gmail.channel.js';
import { NotificationService } from '../modules/notification/notification.service.js';
import { QrPdfService } from '../modules/notification/qr-pdf.service.js';
import { renderNotification, type NotificationTemplate } from '../modules/notification/notification.templates.js';
import { WhatsappChannel } from '../modules/notification/whatsapp.channel.js';
import { QueueService } from './queue.service.js';
import { QUEUES } from './queues.js';
import { InventoryService } from '../modules/inventory/inventory.service.js';

type CallbackJob={provider:string;eventId:string;payload?:Record<string,unknown>};
type NotificationJob={notificationId:string;orderId:string;channel:'EMAIL'|'WHATSAPP';template:NotificationTemplate;recipient:string;orderNumber:string;reason?:string};
@Injectable()
export class IntegrationProcessor implements OnModuleInit {
  constructor(private readonly queues:QueueService,private readonly prisma:PrismaService,private readonly payments:PaymentsService,private readonly orders:OrdersService,private readonly connectivityService:ConnectivityService,private readonly notifications:NotificationService,private readonly gmail:GmailChannel,private readonly whatsapp:WhatsappChannel,private readonly qrPdf:QrPdfService,private readonly inventory:InventoryService){}
  onModuleInit(){this.queues.registerWorker(QUEUES.notifications,job=>this.notification(job as Job<NotificationJob>));this.queues.registerWorker(QUEUES.payments,job=>this.payment(job as Job<CallbackJob>));this.queues.registerWorker(QUEUES.providerCallbacks,job=>this.connectivity(job as Job<CallbackJob>))}
  private async payload(job:CallbackJob){if(job.payload)return job.payload;if(!this.prisma.enabled)return {};return (await this.prisma.webhookEvent.findUnique({where:{source_eventId:{source:job.provider,eventId:job.eventId}}}))?.payload as Record<string,unknown>??{}}
  private async start(job:CallbackJob){if(!this.prisma.enabled)return;await this.prisma.webhookEvent.update({where:{source_eventId:{source:job.provider,eventId:job.eventId}},data:{processingStartedAt:new Date(),attemptCount:{increment:1},nextAttemptAt:null}})}
  private async complete(job:CallbackJob,error?:unknown,attempt=1){if(!this.prisma.enabled)return;const failed=Boolean(error);const terminal=failed&&attempt>=3;await this.prisma.webhookEvent.update({where:{source_eventId:{source:job.provider,eventId:job.eventId}},data:{processedAt:failed?null:new Date(),processingStartedAt:null,errorMessage:error instanceof Error?error.message.slice(0,2000):null,nextAttemptAt:failed&&!terminal?new Date(Date.now()+Math.min(60_000,2_000*2**Math.max(0,attempt-1))):null,deadLetteredAt:terminal?new Date():null}})}
  private async notification(job:Job<NotificationJob>){await this.notifications.mark(job.data.notificationId,'SENDING');try{const order=job.data.template==='QR_READY'&&job.data.orderId?this.orders.get(job.data.orderId):null;let msisdn;if(order){const inventory=this.prisma.enabled&&job.data.orderId?await this.inventory.inventoryForOrder(job.data.orderId):null;msisdn=inventory?.msisdn??order.traveler?.mobile??order.topUpMobile??undefined}const message=renderNotification(job.data.template,{orderNumber:job.data.orderNumber,...(job.data.reason?{reason:job.data.reason}:{}),...(msisdn?{msisdn}:{})});let result;if(job.data.channel==='EMAIL'){const attachment=order?await this.qrAttachment(job,order):undefined;result=await this.gmail.send({to:job.data.recipient,...message,...(attachment?{attachment}:{})})}else{result=await this.whatsapp.send({to:job.data.recipient,text:message.text})}await this.notifications.mark(job.data.notificationId,result.simulated?'SIMULATED':'SENT');return result}catch(error){await this.notifications.mark(job.data.notificationId,'FAILED');throw error}}
  private async qrAttachment(job:Job<NotificationJob>,order:NonNullable<ReturnType<OrdersService['get']>>){if(job.data.template!=='QR_READY')return undefined;const qrPayload=order.qrPayload;if(!qrPayload)return undefined;const png=await QRCode.toBuffer(qrPayload,{width:720,margin:3,errorCorrectionLevel:'M'});return {filename:`${job.data.orderNumber}-esim-qr.png`,contentType:'image/png',base64:png.toString('base64')}}
  private async payment(job:Job<CallbackJob>){await this.start(job.data);const payload=await this.payload(job.data);try{const orderId=String(payload.orderId??'');const reference=String(payload.reference??'');if(!orderId||!reference)throw new Error('Payment callback requires orderId and reference');const result=await this.payments.verifyCallback(orderId,reference);await this.complete(job.data);return result}catch(error){await this.complete(job.data,error,job.attemptsMade+1);throw error}}
  private async connectivity(job:Job<CallbackJob>){await this.start(job.data);const payload=await this.payload(job.data);try{const result=await this.connectivityService.handleWebhook(payload);if(!result.handled){await this.complete(job.data);return {accepted:true,skipped:true,reason:result.reason}}if(result.event)await this.orders.applyProviderEvent(result.event);await this.complete(job.data);return {accepted:true,...result}}catch(error){await this.complete(job.data,error,job.attemptsMade+1);throw error}}
}
