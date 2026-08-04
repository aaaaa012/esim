import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../infrastructure/prisma.service.js';
import { QueueService } from '../../jobs/queue.service.js';
import { QUEUES } from '../../jobs/queues.js';
import type { NotificationTemplate } from './notification.templates.js';

export type NotificationChannel='EMAIL'|'WHATSAPP';
type MemoryNotification={id:string;orderId:string;channel:string;template:string;status:string;sentAt:Date|null;createdAt:Date};
@Injectable()
export class NotificationService {
  private readonly memory=new Map<string,MemoryNotification>();
  constructor(private readonly prisma:PrismaService,private readonly queues:QueueService){}
  async enqueue(input:{orderId:string;channel:NotificationChannel;template:NotificationTemplate;recipient:string;orderNumber:string;reason?:string}){const id=randomUUID();if(this.prisma.enabled)await this.prisma.notification.create({data:{id,orderId:input.orderId,channel:input.channel,template:input.template,status:'QUEUED'}});else this.memory.set(id,{id,orderId:input.orderId,channel:input.channel,template:input.template,status:'QUEUED',sentAt:null,createdAt:new Date()});await this.queues.add(QUEUES.notifications,'deliver-notification',{notificationId:id,...input},`notification-${id}`);if(!this.queues.enabled)await this.mark(id,'SENT');return {id,status:this.queues.enabled?'QUEUED':'SENT'};}
  async mark(id:string,status:'QUEUED'|'SENDING'|'SENT'|'SIMULATED'|'FAILED'){if(this.prisma.enabled){await this.prisma.notification.update({where:{id},data:{status,...(status==='SENT'?{sentAt:new Date()}:{sentAt:null})}});return}const item=this.memory.get(id);if(item){item.status=status;item.sentAt=status==='SENT'?new Date():null}}
  async list(orderIds?:string[]){if(this.prisma.enabled)return this.prisma.notification.findMany({...(orderIds?{where:{orderId:{in:orderIds}}}:{}),orderBy:{createdAt:'desc'},take:200});return [...this.memory.values()].filter(item=>!orderIds||orderIds.includes(item.orderId)).sort((a,b)=>b.createdAt.getTime()-a.createdAt.getTime())}
  async get(id:string){const item=this.prisma.enabled?await this.prisma.notification.findUnique({where:{id}}):this.memory.get(id);if(!item)throw new NotFoundException('Notification not found');return item}
  async retry(id:string,recipient:string,orderNumber:string){const item=await this.get(id);await this.mark(id,'QUEUED');await this.queues.add(QUEUES.notifications,'deliver-notification',{notificationId:id,orderId:item.orderId!,channel:item.channel,template:item.template,recipient,orderNumber},`notification-retry-${id}-${Date.now()}`);return {id,status:'QUEUED'}}
}
