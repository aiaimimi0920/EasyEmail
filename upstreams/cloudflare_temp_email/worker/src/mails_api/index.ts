import { Hono } from 'hono'

import parsed_mail_api from './parsed_mail_api';
import mails_crud from './mails_crud';
import new_address from './new_address';
import auto_reply from './auto_reply'
import webhook_settings from './webhook_settings';
import s3_attachment from './s3_attachment';
import address_auth from './address_auth';
import { conditionalMailDelete, mailDeletionStatus } from './conditional_delete';
import { getBooleanValue } from '../utils';
import { addressDeletionCapability, conditionalAddressDelete, addressDeletionStatus } from './conditional_address_delete';
import { mailboxIdentity } from './mailbox_identity';

export const api = new Hono<HonoCustomType>()

// auto reply
api.get('/api/auto_reply', auto_reply.getAutoReply)
api.post('/api/auto_reply', auto_reply.saveAutoReply)

// webhook
api.get('/api/webhook/settings', webhook_settings.getWebhookSettings)
api.post('/api/webhook/settings', webhook_settings.saveWebhookSettings)
api.post('/api/webhook/test', webhook_settings.testWebhookSettings)

// attachment (S3)
api.get('/api/attachment/list', s3_attachment.list)
api.post('/api/attachment/delete', s3_attachment.deleteKey)
api.post('/api/attachment/put_url', s3_attachment.getSignedPutUrl)
api.post('/api/attachment/get_url', s3_attachment.getSignedGetUrl)

// mail crud
api.get('/api/mails', mails_crud.listMails)
api.get('/api/mail/:mail_id', mails_crud.getMail)
api.delete('/api/mails/:id', mails_crud.deleteMail)
api.post('/api/mail_deletions', (c) => conditionalMailDelete(c.req.raw, c.env.DB, c.get('jwtPayload'), getBooleanValue(c.env.ENABLE_USER_DELETE_EMAIL)))
api.get('/api/mail_deletions/:request_id', (c) => mailDeletionStatus(c.req.param('request_id'), c.env.DB, c.get('jwtPayload')))

// parsed mail (server-side parsed subject/text/html/attachments)
api.get('/api/parsed_mails', parsed_mail_api.listParsedMails)
api.get('/api/parsed_mail/:mail_id', parsed_mail_api.getParsedMail)

// address settings / lifecycle
api.get('/api/mailbox_identity', (c) => mailboxIdentity(c.env.DB, c.get('jwtPayload')))
api.get('/api/settings', mails_crud.getSettings)
api.post('/api/new_address', new_address.createNewAddress)
api.delete('/api/delete_address', mails_crud.deleteAddress)
api.get('/api/address_deletion_capability', (c) => addressDeletionCapability(c.env.DB, c.get('jwtPayload'), getBooleanValue(c.env.ENABLE_USER_DELETE_EMAIL)))
api.post('/api/address_deletions', (c) => conditionalAddressDelete(c.req.raw, c.env.DB, c.get('jwtPayload'), getBooleanValue(c.env.ENABLE_USER_DELETE_EMAIL)))
api.get('/api/address_deletions/:request_id', (c) => addressDeletionStatus(c.req.param('request_id'), c.env.DB, c.get('jwtPayload')))
api.delete('/api/clear_inbox', mails_crud.clearInbox)
api.delete('/api/clear_sent_items', mails_crud.clearSentItems)

// address auth
api.post('/api/address_change_password', address_auth.changePassword)
api.post('/api/address_login', address_auth.login)
