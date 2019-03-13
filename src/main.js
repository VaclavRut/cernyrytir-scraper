const Apify = require('apify');
const requestPromise = require('request-fixed-tunnel-agent');
const cheerio = require('cheerio');
const moment = require('moment');
const iconv = require('iconv-lite');
const { getRandomInt } = require('./utils');

async function enqueueItems(items, requestQueue, priority) {
    if (items.length !== 0) {
        console.log(`Enqueueing ${items.length} ${items[0].userData.label}`);
        for (const item of items) {
            if (priority === true) {
                await requestQueue.addRequest(item, { forefront: true });
            } else {
                await requestQueue.addRequest(item);
            }
        }
    } else {
        console.log('Nothing to enqueue.');
    }
}

function getCards($) {
    const cards = [];
    const table = $('table.kusovkytext').eq(1);
    table.find('tbody tr[bgcolor]:nth-child(3n)').each(function (index) {
        cards[index] = {};
        cards[index].rarity = $(this).find('td[align="left"]').text();
        cards[index].stockCount = $(this).find('td[align="center"]').eq(0).text();
        cards[index].price = $(this).find('td[align="center"]').eq(1).text();

        const secondRow = $(this).prev('tr');
        cards[index].edition = secondRow.find('td[align="left"]').text();
        cards[index].cardType = secondRow.find('td[align="right"]').text();

        const firstRow = secondRow.prev('tr');

        cards[index].title = firstRow.find('div[title]').text().trim();
        cards[index].description = firstRow.find('div[title]').attr('title');
    });
    console.log(cards);
    return cards;
}

Apify.main(async () => {
    const input = await Apify.getValue('INPUT');
    // const requestQueue = await Apify.openRequestQueue(`cernyRytir-${moment().format('YYYY-MM-DD')}`);
    const requestQueue = await Apify.openRequestQueue();

    await requestQueue.addRequest(new Apify.Request({
        url: 'http://cernyrytir.cz/index.php3?akce=3',
        userData: {
            label: 'START',
        },
    }));

    // for testing, you can just skip enqueuing the whole listing and go to page directly
    /*
        await requestQueue.addRequest(new Apify.Request({
            url: 'http://cernyrytir.cz/index.php3?akce=3&limit=0&edice_magic=RNA&poczob=30&triditpodle=ceny&hledej_pouze_magic=1&submit=Vyhledej',
            userData: {
                label: 'PAGE',
            },
        }));
    */
    const crawler = new Apify.BasicCrawler({
        requestQueue,
        retireInstanceAfterRequestCount: 1,
        maxRequestRetries: input.maxRetries || 5,
        maxConcurrency: input.maxConcurrency || 5,
        autoscaledPoolOptions: {
            systemStatusOptions: {
                maxEventLoopOverloadedRatio: 0.7,
                maxCpuOverloadedRatio: 0.6,
                maxClientOverloadedRatio: 0.4,
            },
        },
        handleRequestFunction: async ({ request }) => {
            console.log(`Handling the request -> ${request.url}, label ${request.userData.label}`);

            const response = await requestPromise({
                url: request.url,
                // proxy: Apify.getApifyProxyUrl(),
                headers: {
                    'User-Agent': Apify.utils.getRandomUserAgent(),
                },
                encoding: null,
                resolveWithFullResponse: true,
            });

            const { body, statusCode } = response;
            const decodedBody = iconv.decode(body, 'cp1250');
            const $ = cheerio.load(body);
            $.find = $;

            if (statusCode !== 200) {
                await Apify.utils.sleep(getRandomInt(3000, 5000));
                throw new Error(`Got status: ${statusCode}`);
            }

            if (request.userData.label === 'START') {
                // get initial set of categories
                const categoryLinks = [];
                // await Apify.setValue('page.html',$('table').html())
                // console.log($('table.kusovkytext').eq(1).html())
                $('table.kusovkytext').eq(1).find('td a').each(function () {
                    const categoryUrl = `http://cernyrytir.cz/${$(this).attr('href')}`;
                    console.log(categoryUrl)
                    categoryLinks.push({
                        url: categoryUrl,
                        userData: {
                            label: 'CATEGORY',
                        },
                    });
                });
                await enqueueItems(categoryLinks, requestQueue);
            } else if (request.userData.label === 'CATEGORY') {
                // enqueue pagination
                const paginationUrl = $('span.kusovkytext').eq(0).find('a').eq(0)
                    .attr('href');
                const paginationUrls = [];
                const cardCount = Math.ceil(parseInt($('span.kusovkytext').eq(0).text().match(/\d+/)) / 30) * 30;
                for (let i = 30; i <= cardCount; i += 30) {
                    const paginationParam = `limit=${i}`;
                    paginationUrls.push({
                        url: paginationUrl.replace(/limit=\d+/, paginationParam),
                        userData: {
                            label: 'PAGE',
                        },
                    });
                }
                await enqueueItems(paginationUrls, requestQueue);
                await Apify.pushData(await getCards($, request));
            } else if (request.userData.label === 'PAGE') {
                // parse cards
                await Apify.pushData(await getCards($, request));
            }

            // to slow down
            await Apify.utils.sleep(getRandomInt(3000, 5000));
        },
        handleFailedRequestFunction: async ({ request }) => {
            await Apify.pushData({
                status: 'Page failed 4 times, check it out, what happened.',
                url: request.url,
            });
            console.log(`Request ${request.url} failed 4 times`);
        },
    });
    await crawler.run();
    console.log('Finished.');
});
