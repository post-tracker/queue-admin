require('dotenv').config();

const Queue = require( 'bull' );

if ( !process.env.REDIS_URL ) {
    throw new Error( 'Got no queue, exiting' );
}

const redditQueue = new Queue(
    'reddit-posts',
    process.env.REDIS_URL,
    {
        limiter: {
            max: 1,
            duration: 2000, // Might be 2 requests / post (content & parent)
        },
    }
);

let lastFailCount = false;

redditQueue.on( 'error', ( queueError ) => {
    console.error( queueError );
} );

redditQueue.on( 'failed', ( job, jobError ) => {
    console.error( jobError );
} );

const removeCollisions = async function removeCollisions(){
    let failedCount = false;
    try {
        failedCount = await redditQueue.getFailedCount();
    } catch (failedCountError){
        console.error(failedCountError);
    }
    
    if(failedCount === 0){
        return true;
    }
    
    if(lastFailCount === failedCount){
        console.log(`No jobs removed, stopping`);
        
        return true;
    }
    
    lastFailCount = failedCount;
    
    console.log(failedCount);
    
    let jobs;
    
    try {
        jobs = await redditQueue.getFailed(0, Math.min(100, failedCount));
    } catch (someError){
        console.log(someError);
    }
            
    for(const job of jobs){
        if(!job.failedReason.includes('/posts returned 409')){
            console.log(job.failedReason);
            
            continue;
        }
        
        try {
            await job.remove();
        } catch (removeError){
            console.error(removeError);
        }
    }
    
    return await removeCollisions();
};

( async () => {
    await removeCollisions();
    
    redditQueue.close();
})();

