require( 'dotenv' ).config();

const Arena = require( 'bull-arena' );
const Redis = require( 'ioredis' );
const express = require( 'express' );
const basicAuth = require( 'express-basic-auth' );

const app = express();
const router = express.Router();

const DEFAULT_LISTEN_PORT =  4000;

// A transient Redis outage (Heroku failover, network blip) makes ioredis/bull
// emit errors that, left unhandled, crash the process and put the container in
// a restart loop. This is a read-only monitoring UI, so log and keep running —
// ioredis will reconnect on its own (see retryStrategy below).
process.on( 'uncaughtException', ( error ) => {
    console.error( 'Uncaught exception (continuing):', error );
} );
process.on( 'unhandledRejection', ( error ) => {
    console.error( 'Unhandled rejection (continuing):', error );
} );

// Build ioredis connection options from a redis:// URL, adding resilience
// settings. We parse the URL rather than passing the string through so we can
// inject these options; the derived fields match what ioredis would parse from
// the same URL, so AUTH/TLS behavior is unchanged.
const buildRedisOptions = function buildRedisOptions ( redisUrl ) {
    const parsed = new URL( redisUrl );

    const options = {
        host: parsed.hostname,
        port: Number( parsed.port ) || 6379,
        // Keep retrying commands across reconnects instead of throwing
        // MaxRetriesPerRequestError after ioredis' default of 20 retries.
        maxRetriesPerRequest: null,
        // Reconnect with a capped backoff after the connection drops.
        retryStrategy: ( times ) => Math.min( times * 200, 5000 ),
    };

    if ( parsed.username ) {
        options.username = parsed.username;
    }

    if ( parsed.password ) {
        options.password = parsed.password;
    }

    if ( parsed.protocol === 'rediss:' ) {
        options.tls = {};
    }

    return options;
};

// Returns a bull `createClient(type)` factory so we own the ioredis clients and
// can log their connection lifecycle. Bull creates a few client types per queue
// ('client', 'subscriber', and 'bclient' for blocking ops); we label logs by
// type so it's clear which connection is doing what.
const createRedisClient = function createRedisClient ( redisUrl ) {
    const baseOptions = buildRedisOptions( redisUrl );

    console.log( `[redis] target ${ baseOptions.host }:${ baseOptions.port }${ baseOptions.tls ? ' (tls)' : '' }` );

    return ( type ) => {
        const options = Object.assign( {}, baseOptions );

        // bull requires these for its blocking and subscriber clients.
        if ( type === 'bclient' || type === 'subscriber' ) {
            options.enableReadyCheck = false;
            options.maxRetriesPerRequest = null;
        }

        const client = new Redis( options );

        client.on( 'connect', () => console.log( `[redis:${ type }] connecting` ) );
        client.on( 'ready', () => console.log( `[redis:${ type }] ready` ) );
        client.on( 'error', ( error ) => console.error( `[redis:${ type }] error: ${ error.message }` ) );
        client.on( 'close', () => console.warn( `[redis:${ type }] connection closed` ) );
        client.on( 'reconnecting', ( delay ) => console.warn( `[redis:${ type }] reconnecting in ${ delay }ms` ) );
        client.on( 'end', () => console.warn( `[redis:${ type }] connection ended; no further reconnects` ) );

        return client;
    };
};

if ( !process.env.QUEUES ) {
    throw new Error( 'Unable to load queues' );
}

let queues;

try {
    queues = JSON.parse( process.env.QUEUES );
} catch ( JSONParseError ) {
    throw JSONParseError;
}

const users = {};

// eslint-disable-next-line no-process-env
users[ process.env.ACCESS_USERNAME ] = process.env.ACCESS_PASSWORD;

const getUnauthorizedResponse = function getUnauthorizedResponse ( request ) {
    if ( request.auth ) {
        return `Credentials ${ request.auth.user }:${ request.auth.password } rejected`;
    }

    return 'No credentials provided';
};

for ( const queue of queues ) {
    const redisUrl = process.env.REDIS_URL || queue.url;

    if ( redisUrl ) {
        queue.createClient = createRedisClient( redisUrl );
        delete queue.url;
    }
}

const arena = Arena(
    {
        queues: queues,
    },
    {
        disableListen: true,
    },
);

router.use( '/', arena );

app.use( basicAuth( {
    challenge: true,
    unauthorizedResponse: getUnauthorizedResponse,
    users: users,
} ), ( request, response, next ) => {
    response.cookie( 'request-user', request.auth.user );
    response.cookie( 'request-password', request.auth.password );

    next();
} );
app.use( router );

app.listen( process.env.PORT || DEFAULT_LISTEN_PORT, () => {
    // eslint-disable-next-line no-process-env
    console.log( `Queue admin interface listening on port ${ process.env.PORT || DEFAULT_LISTEN_PORT }!` );
} );
