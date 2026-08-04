import { Injectable, OnModuleInit } from '@nestjs/common';
import type { Job } from 'bullmq';
import { PrismaService } from '../infrastructure/prisma.service.js';
import { OrdersService } from '../modules/orders/orders.service.js';
import { PaymentsService } from '../modules/payments/payments.service.js';
import { GmailChannel } from '../modules/notification/gmail.channel.js';
import { NotificationService } from '../modules/notification/notification.service.js';
import { renderNotification, type NotificationTemplate } from '../modules/notification/notification.templates.js';
import { WhatsappChannel } from '../modules/notification/whatsapp.channel.js';
import { QueueService } from './queue.service.js';
import { QUEUES } from './queues.js';

type CallbackJob={provider:string;eventId:string;payload?:Record<string,unknown>};
type NotificationJob={notificationId:string;channel:'EMAIL'|'WHATSAPP';template:NotificationTemplate;recipient:string;orderNumber:string;reason?:string};
@Injectable()
export class IntegrationProcessor implements OnModuleInit {
  constructor(private readonly queues:QueueService,private readonly prisma:PrismaService,private readonly payments:PaymentsService,private readonly orders:OrdersService,private readonly notifications:NotificationService,private readonly gmail:GmailChannel,private readonly whatsapp:WhatsappChannel){}
  onModuleInit(){this.queues.registerWorker(QUEUES.notifications,job=>this.notification(job as Job<NotificationJob>));this.queues.registerWorker(QUEUES.payments,job=>this.payment(job as Job<CallbackJob>));this.queues.registerWorker(QUEUES.providerCallbacks,job=>this.connectivity(job as Job<CallbackJob>))}
  private async payload(job:CallbackJob){if(job.payload)return job.payload;if(!this.prisma.enabled)return {};return (await this.prisma.webhookEvent.findUnique({where:{source_eventId:{source:job.provider,eventId:job.eventId}}}))?.payload as Record<string,unknown>??{}}
  private async complete(job:CallbackJob,error?:unknown){if(!this.prisma.enabled)return;await this.prisma.webhookEvent.update({where:{source_eventId:{source:job.provider,eventId:job.eventId}},data:{processedAt:new Date(),errorMessage:error instanceof Error?error.message:null}})}
  private async notification(job:Job<NotificationJob>){await this.notifications.mark(job.data.notificationId,'SENDING');try{const message=renderNotification(job.data.template,{orderNumber:job.data.orderNumber,...(job.data.reason?{reason:job.data.reason}:{})});const result=job.data.channel==='EMAIL'?await this.gmail.send({to:job.data.recipient,...message}):await this.whatsapp.send({to:job.data.recipient,text:message.text});await this.notifications.mark(job.data.notificationId,result.simulated?'SIMULATED':'SENT');return result}catch(error){await this.notifications.mark(job.data.notificationId,'FAILED');throw error}}
  private async payment(job:Job<CallbackJob>){const payload=await this.payload(job.data);try{const orderId=String(payload.orderId??'');const reference=String(payload.reference??'');if(!orderId||!reference)throw new Error('Payment callback requires orderId and reference');const result=await this.payments.verifyCallback(orderId,reference);await this.complete(job.data);return result}catch(error){await this.complete(job.data,error);throw error}}
  private async connectivity(job:Job<CallbackJob>){const payload=await this.payload(job.data);try{const orderId=String(payload.orderId??'');const qrPayload=String(payload.qrPayload??'');if(!orderId||!qrPayload)throw new Error('Connectivity callback requires orderId and qrPayload');const result=await this.orders.completeConnectivityCallback(orderId,qrPayload,job.data.provider);await this.complete(job.data);return result}catch(error){await this.complete(job.data,error);throw error}}
}
