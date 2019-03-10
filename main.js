const Apify = require('apify');

Apify.main(async () => {
  // get and check INPUT
  const input = await Apify.getValue('INPUT');
  if (!input || !input.keyword) throw new Error('INPUT must have a keyword property!');

  // base URLs
  const baseUrl = 'https://www.amazon.com/s?k=';
  const baseProductUrl = 'https://www.amazon.com/dp/';
  const baseOfferUrl = 'https://www.amazon.com/gp/offer-listing/';

  // open a dataset
  const dataset = await Apify.openDataset('amazon-assignment-v2');

  // create queue and enqueu start url
  const requestQueue = await Apify.openRequestQueue();
  await requestQueue.addRequest({
    url: baseUrl + input.keyword,
    userData: {
      label: 'start',
      keyword: input.keyword
    }
  });

  // create crawler
  const crawler = new Apify.PuppeteerCrawler({
    requestQueue,

    launchPuppeteerOptions: {
      liveView: true,
      useApifyProxy: true,
      apifyProxyGroups: ['SHADER']
    },

    handlePageFunction: async ({ page, request }) => {
      console.log(`Request ${request.url} succeeded!`);
      // slow down crawling
      await page.waitFor(1000);

      // if start page
      if (request.userData.label == 'start') {
        console.log('Going to evaluate the start page:', request.url);

        try {
          await page.waitForSelector('.s-result-list', { timeout: 10000 });

          const asins = await page.evaluate(() => {
            const asins = [];
            const itemDivs = Array.from(document.querySelector('.s-result-list').children);

            if (itemDivs.length != 0) {
              itemDivs.forEach((div) => {
                const asin = div.dataset.asin;
                asins.push(asin);
              });
            }

            return asins;
          });

          const items = asins.map((asin) => {
            const productUrl = baseProductUrl + asin;
            const sellerUrl = baseOfferUrl + asin;
            return {asin, productUrl, sellerUrl, keyword: request.userData.keyword};
          });

          // add items to the queue
          for (const item of items) {
            await requestQueue.addRequest({
              url: item.productUrl,
              userData: {
                label: 'product',
                asin: item.asin,
                keyword: item.keyword,
                productUrl: item.productUrl,
                sellerUrl: item.sellerUrl
              }
            });
          }
        } catch (err) {
          console.log(err);
          await dataset.pushData({
              url: request.url,
              status: 'No results for this search keyword.',
          });
        }

        console.log('Product Pages added. Keep on crawling.');
      }

      // if product page
      else if (request.userData.label == 'product') {
        console.log('Going to evaluate a product page: ' + request.url);

        try {
          await page.waitForSelector('#title', { timeout: 10000 });
        } catch (err) {
          console.log(err);
          // rest is taken care below.
        }

        const productInfo = await page.evaluate(() => {
          const title = document.getElementById('title') ? document.getElementById('title').innerText : 'No title available.';
          const description = document.getElementById('productDescription') ? document.getElementById('productDescription').innerText : 'No description available.';

          return {title, description};
        });

        // extract info
        const { asin, keyword, productUrl } = request.userData;

        // add to queue
        await requestQueue.addRequest({
          url: request.userData.sellerUrl,
          userData: {
            label: 'seller',
            asin,
            keyword,
            productUrl,
            title: productInfo.title,
            description: productInfo.description
          }
        });

        console.log('Done with ' + request.url);
        console.log('Added to queue: ' + request.userData.sellerUrl);

      }

      // if seller page
      else if (request.userData.label == 'seller') {
        console.log('Going to evaluate a seller page: ' + request.url);

        try {
          await page.waitForSelector('#olpOfferList', { timeout: 10000 });
        } catch (err) {
          console.log(err);
          // rest is taken care below.
        }

        const sellerPage = await page.evaluate(() => {
          const offers = [];
          const offerList = document.getElementById('olpOfferList');
          const offerItems = offerList ? Array.from(offerList.querySelectorAll('div.a-row.a-spacing-mini.olpOffer')) || [] : [];

          offerItems.forEach((item) => {
            // const price = item.querySelector('.olpPriceColumn').innerText.match(/\$\d+(\.\d+)?/)[0];
            const price = item.querySelector('.olpOfferPrice').innerText;
            const condition = item.querySelector('.olpConditionColumn').innerText;
            const shipping = item.querySelector('.olpDeliveryColumn').innerText;
            const sellerName = item.querySelector('.olpSellerName').innerText || 'Amazon.com';

            offers.push({price, condition, shipping, sellerName});
          });

          // check for pagination
          const next = document.querySelector('ul.a-pagination li.a-last a');
          const nextUrl = next ? next.href || null : null;

          return {
            offers,
            nextUrl
          }
        });

        // add offers
        if (!request.userData.offers) request.userData.offers = sellerPage.offers;
        else request.userData.offers = request.userData.offers.concat(sellerPage.offers);

        // if next page exists
        if (sellerPage.nextUrl) {
          console.log('Next Page exists:', sellerPage.nextUrl);

          // addRequest
          await requestQueue.addRequest({
            url: sellerPage.nextUrl,
            userData: request.userData,
          });

          console.log('Next Page added to queue.');
        }
        else {
          // extract info
          const { asin, keyword, productUrl, title, description, offers } = request.userData;

          // construct final obj and push it to dataset
          const item = {
            title,
            itemUrl: productUrl,
            description,
            keyword,
            asin,
            offers
          }

          await dataset.pushData(item);
          console.log('Pushed data. Asin:', item.asin);
        }
      }

    },

    handleFailedRequestFunction: async ({ request }) => {
        console.log(`Request ${request.url} failed 4 times`);

        await dataset.pushData({
            url: request.url,
            errors: request.errorMessages,
        });
    }

  });

  await crawler.run();
  console.log('Done.');
});
