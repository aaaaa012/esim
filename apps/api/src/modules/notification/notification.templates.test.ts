import { describe,expect,it } from 'vitest';
import { renderNotification } from './notification.templates.js';
describe('notification templates',()=>{it('does not expose QR credentials in the ready message',()=>{const value=renderNotification('QR_READY',{orderNumber:'VC-2026-TEST'});expect(value.text.toLowerCase()).toContain('sign in');expect(value.text).not.toContain('LPA:')});it('includes the operator reason in a re-upload request',()=>{expect(renderNotification('DOCUMENT_REUPLOAD',{orderNumber:'VC-1',reason:'Image is blurred'}).text).toContain('Image is blurred')})});
