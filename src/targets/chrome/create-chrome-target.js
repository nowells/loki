const fs = require('fs-extra');
const debug = require('debug')('loki:chrome');
const presets = require('./presets.json');
const disableAnimations = require('./disable-animations');
const getSelectorBoxSize = require('./get-selector-box-size');
const getStories = require('./get-stories');
const awaitLokiReady = require('./await-loki-ready');
const {
  withTimeout,
  TimeoutError,
  withRetries,
} = require('../../failure-handling');
const { FetchingURLsError, ServerError } = require('../../errors');

const LOADING_STORIES_TIMEOUT = 60000;
const CAPTURING_SCREENSHOT_TIMEOUT = 30000;

function createChromeTarget(start, stop, createNewDebuggerInstance, baseUrl) {
  function getDeviceMetrics(options) {
    return {
      width: options.width,
      height: options.height,
      deviceScaleFactor: options.deviceScaleFactor || 1,
      mobile: options.mobile || false,
      fitWindow: options.fitWindow || false,
    };
  }

  async function launchNewTab(options) {
    const client = await createNewDebuggerInstance();
    const deviceMetrics = getDeviceMetrics(options);

    const { Runtime, Page, Emulation, DOM, Network } = client;

    await Runtime.enable();
    await Network.enable();
    await DOM.enable();
    await Page.enable();
    if (options.userAgent) {
      await Network.setUserAgentOverride({
        userAgent: options.userAgent,
      });
    }
    if (options.clearBrowserCookies) {
      await Network.clearBrowserCookies();
    }
    await Emulation.setDeviceMetricsOverride(deviceMetrics);

    const awaitRequestsFinished = async () => {
      const requestURLMap = {};
      const failedURLs = [];

      const requestFailed = requestId => {
        failedURLs.push(requestURLMap[requestId]);
      };

      Network.requestWillBeSent(({ requestId, request }) => {
        requestURLMap[requestId] = request.url;
      });

      Network.responseReceived(({ requestId, response }) => {
        if (response.status >= 400) {
          requestFailed(requestId);
        }
      });

      Network.loadingFailed(({ requestId }) => {
        requestFailed(requestId);
      });

      await Page.loadEventFired();

      if (failedURLs.length !== 0) {
        throw new FetchingURLsError(failedURLs);
      }
    };

    const evaluateOnNewDocument = scriptSource => {
      if (Page.addScriptToEvaluateOnLoad) {
        // For backwards support
        return Page.addScriptToEvaluateOnLoad({ scriptSource });
      }
      return Page.addScriptToEvaluateOnNewDocument({ scriptSource });
    };

    const executeFunctionWithWindow = async (functionToExecute, ...args) => {
      const stringifiedArgs = ['window']
        .concat(args.map(JSON.stringify))
        .join(',');
      const expression = `(() => Promise.resolve((${functionToExecute})(${stringifiedArgs})).then(JSON.stringify))()`;
      const { result } = await Runtime.evaluate({
        expression,
        awaitPromise: true,
      });
      if (result.subtype === 'error') {
        throw new Error(
          result.description.replace(/^Error: /, '').split('\n')[0]
        );
      }
      return result.value && JSON.parse(result.value);
    };

    client.executeFunctionWithWindow = executeFunctionWithWindow;

    client.loadUrl = async url => {
      if (!options.chromeEnableAnimations) {
        debug('Disabling animations');
        await evaluateOnNewDocument(disableAnimations.asString);
      }

      debug(`Navigating to ${url}`);
      await Promise.all([Page.navigate({ url }), awaitRequestsFinished()]);

      debug('Awaiting runtime setup');
      await executeFunctionWithWindow(awaitLokiReady);
    };

    const getPositionInViewport = async selector => {
      try {
        return await executeFunctionWithWindow(getSelectorBoxSize, selector);
      } catch (error) {
        if (error.message === 'Unable to find element') {
          throw new Error(
            `Unable to get position of selector "${selector}". Review the \`chromeSelector\` option and make sure your story doesn't crash.`
          );
        }
        throw error;
      }
    };

    client.captureScreenshot = withRetries(options.chromeRetries)(
      withTimeout(
        CAPTURING_SCREENSHOT_TIMEOUT,
        'captureScreenshot'
      )(async (selector = 'body') => {
        debug(`Getting viewport position of "${selector}"`);
        const position = await getPositionInViewport(selector);

        debug('Capturing screenshot');
        const clip = Object.assign({ scale: 1 }, position);
        const screenshot = await Page.captureScreenshot({
          format: 'png',
          clip,
        });
        const buffer = new Buffer(screenshot.data, 'base64');

        return buffer;
      })
    );

    return client;
  }

  const getStoryUrl = (kind, story) =>
    `${baseUrl}/iframe.html?selectedKind=${encodeURIComponent(
      kind
    )}&selectedStory=${encodeURIComponent(story)}`;

  async function getStorybook() {
    const tab = await launchNewTab({
      width: 100,
      height: 100,
      chromeEnableAnimations: true,
      clearBrowserCookies: false,
    });
    const url = `${baseUrl}/iframe.html`;
    try {
      await withTimeout(LOADING_STORIES_TIMEOUT)(tab.loadUrl(url));
    } catch (error) {
      if (
        error instanceof TimeoutError ||
        (error instanceof FetchingURLsError && error.failedURLs.includes(url))
      ) {
        throw new ServerError(
          'Failed fetching stories because the server is down',
          `Try starting it with "yarn storybook" or pass the --port or --host arguments if it's not running at ${baseUrl}`
        );
      }
      throw error;
    }
    return tab.executeFunctionWithWindow(getStories);
  }

  async function captureScreenshotForStory(
    kind,
    story,
    outputPath,
    options,
    configuration
  ) {
    let tabOptions = configuration;
    if (configuration.preset) {
      if (!presets[configuration.preset]) {
        throw new Error(`Invalid preset ${configuration.preset}`);
      }
      tabOptions = Object.assign(
        {},
        configuration,
        presets[configuration.preset]
      );
    }
    const selector = configuration.chromeSelector || options.chromeSelector;
    const url = getStoryUrl(kind, story);

    const tab = await launchNewTab(tabOptions);
    try {
      await withTimeout(options.chromeLoadTimeout)(tab.loadUrl(url));
    } catch (err) {
      if (err instanceof TimeoutError) {
        debug(`Timed out waiting for "${url}" to load`);
      } else {
        throw err;
      }
    }
    const screenshot = await tab.captureScreenshot(selector);
    await fs.outputFile(outputPath, screenshot);
    await tab.close();
    return screenshot;
  }

  return { start, stop, getStorybook, launchNewTab, captureScreenshotForStory };
}

module.exports = createChromeTarget;
