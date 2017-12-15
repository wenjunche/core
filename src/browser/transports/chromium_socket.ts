/*
Copyright 2017 OpenFin Inc.

Licensed under OpenFin Commercial License you may not use this file except in compliance with your Commercial License.
Please contact OpenFin Inc. at sales@openfin.co to obtain a Commercial License.
*/

import {net} from 'electron';
import {parse as parseUrl, format as formatUrl, Url} from 'url';
import * as log from '../log';
import ofEvents from '../of_events';
import route from '../../common/route';

import * as nodeNet from 'net';

interface RequestProtocol {
    port: number;
    secureProtocol?: string; // secure version of the protocol
    chromiumProtocol?: string; // protocol Chromium network layer should use to create connection
}

const ProtocolMap: { [index: string]: RequestProtocol } = {
    // tslint:disable-next-line:no-http-string
    'rtmp:' :  { port: 1935, secureProtocol: 'rtmps:',  chromiumProtocol: 'http:'},
    // tslint:disable-next-line:no-http-string
    'rtmps:' : { port: 443,  chromiumProtocol: 'https:'},
    // tslint:disable-next-line:no-http-string
    'http:' : { port: 80,  secureProtocol: 'https:'},
    // tslint:disable-next-line:no-http-string
    'https:' : { port: 443 }
};

enum ProxyEventType {
    Open = 1,
    Listening, //proxy socket starts listening to a port
    Data,
    Closed
}

interface ProxyEvent {
    eventType: ProxyEventType;
    payload?: any;
}

interface ProxyAuthEvent {
    url: string;
    isProxy: boolean;
}

const requestMap: { [url: string]: any } = {};  // map of URL to net.request

export interface CreateProxyResponse {
    success: boolean;
    data?: {port: number, originalUrl: string}; // port# on localhost
}

export interface CreateProxyRequest {
    url: string; // URL to proxy requests to
    callback: (result: CreateProxyResponse) => void;
    errorCallback: (err: any) => void;
}

export interface AuthProxyRequest {
    url: string; // URL for the original CreateProxyRequest
    username: string;
    password: string;
}

export function createChromiumSocket(req: CreateProxyRequest): void {
    const originalUrl: Url = parseUrl(req.url);
    const mappedUrl: Url = parseUrl(req.url);
    if (ProtocolMap.hasOwnProperty(originalUrl.protocol)) {
        const reqProtocol: RequestProtocol = ProtocolMap[originalUrl.protocol];
        if (reqProtocol.chromiumProtocol) {
            mappedUrl.protocol = reqProtocol.chromiumProtocol;
            // in case of http://host:443/...   Yes, it does happen
            if (originalUrl.port === '443' && reqProtocol.secureProtocol) {
                log.writeToLog(1, `applying secure protocol: ${reqProtocol.secureProtocol}`, true);
                if (ProtocolMap.hasOwnProperty(reqProtocol.secureProtocol)) {
                    mappedUrl.protocol = ProtocolMap[reqProtocol.secureProtocol].chromiumProtocol;
                }
            }
        }
    }
    const url: string = formatUrl(mappedUrl);
    log.writeToLog(1, `mapped URL: ${url}`, true);

    const request = net.request({ url, dataSocket: true });
    requestMap[req.url] = request;
    // fired when Chromium socket is connected
    request.on('requestSocketConnected', (response: any) => {
        log.writeToLog(1, 'requestSocketConnected', true);
        startProxyConnection((event: ProxyEvent) => {
            if (event.eventType === ProxyEventType.Data) {
                log.writeToLog(1, `proxy socket output chromium data: ${event.payload.length}`, true);
                request.writeSocket(event.payload);
            }
            if (event.eventType === ProxyEventType.Closed) {
                log.writeToLog(1, 'close chromium socket', true);
                request.closeSocket();
            }
            if (event.eventType === ProxyEventType.Listening) {
                // setting mappedUrl.port does not work.  Have to append to host
                req.callback({success: true, data: {port: event.payload, originalUrl: formatUrl(originalUrl)}});
            }
        }, response);
    });
    request.on('socketAuthRequired', (event: ProxyAuthEvent) => {
        log.writeToLog(1, `proxy socket auth requested: ${event.url}`, true);
        ofEvents.emit(route.system('proxy-socket-auth-requested'), {url: event.url, isProxy: event.isProxy});
    });
    request.on('error', (err: string) => {
        log.writeToLog(1, `proxy socket request error ${err}`, true);
        request.closeSocket();
        if (req.errorCallback) {
            req.errorCallback(err);
        }
    });
    request.on('close', () => {
        log.writeToLog(1, `proxy socket request closed, clean up ${req.url}`, true);
        delete requestMap[req.url];
    });
    request.createConnection();
}

/**
 * Start a node server on localhost as connection proxy
 *
 * @param {(data: any) => void} proxyCallback
 * @param response returned by requestSocketConnected event
 *
 */
function startProxyConnection(proxyCallback: (event: ProxyEvent) => void, response: any) {
    let clientConn: nodeNet.Socket; // only one connection is allowed
    const server = nodeNet.createServer((conn: nodeNet.Socket) => {
        if (!clientConn) {
            log.writeToLog(1, `proxy socket new connection ${conn.localPort}`, true);
            clientConn = conn;
            conn.on('data', (data) => {
                log.writeToLog(1, `proxy socket input data ${data.length}`, true);
                proxyCallback({eventType: ProxyEventType.Data, payload: data});
            });
            conn.on('close', (hadError: boolean) => {
                log.writeToLog(1, `proxy socket closed ${hadError}`, true);
                server.close();
            });
            conn.on('end', () => {
                log.writeToLog(1, 'proxy socket ended', true);
            });
            conn.on('timeout', () => {
                log.writeToLog(1, 'proxy socket timeout', true);
            });
            conn.on('error', (err) => {
                log.writeToLog(1, `proxy socket connect error ${err}`, true);
                // according to the doc, 'close' event will come next
            });
            // data from Chromium socket
            response.on('data', (data: Buffer) => {
                const flushed: boolean = conn.write(data);
                log.writeToLog(1, `proxy socket input chromium data: ${data.length} flushed ${flushed}`, true);
                log.writeToLog(1, `proxy socket input chromium data: ${data.toString('utf8')}`, true);
            });
        } else {
            log.writeToLog(1, `proxy socket duplicate connection: ${JSON.stringify(server.address())}`, true);
            conn.end();
        }
    });
    // error from Chromium socket
    response.on('error', (err: string) => {
        log.writeToLog(1, `proxy socket response error: ${err}`, true);
        if (clientConn) {
            clientConn.destroy();
        } else {
            server.close();
        }
    });
    server.maxConnections = 1;  //only one connection for each proxy
    server.on('listening', () => {
        log.writeToLog(1, `proxy server info ${JSON.stringify(server.address())}`, true);
        proxyCallback({eventType: ProxyEventType.Listening, payload: server.address().port});
    });
    server.on('close', () => {
        log.writeToLog(1, 'proxy server closed', true);
        proxyCallback({eventType: ProxyEventType.Closed});
    });
    server.on('error', (err) => {
        log.writeToLog(1, `proxy server error ${err}`, true);
        server.close();
    });
    server.listen(0, 'localhost');
    //server.listen(8082, 'localhost');
}

export function authenticateChromiumSocket(req: AuthProxyRequest): void {
    const request = requestMap[req.url];
    if (request) {
        request.authenticateSocket(req.username, req.password);
    }
}
