require( 'dotenv' ).config();

const Arena = require( 'bull-arena' );
const express = require( 'express' );
const basicAuth = require( 'express-basic-auth' );

const app = express();
const router = express.Router();

const DEFAULT_LISTEN_PORT =  4000;

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

if ( process.env.REDIS_URL ) {
    for ( const queue of queues ) {
        queue.url = process.env.REDIS_URL;
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
