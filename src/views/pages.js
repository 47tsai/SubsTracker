// 頁面範本 - 使用 text import 避免巢狀範本字面值問題
import themeResourcesHtml from './theme-resources.html';
import adminPageHtml from './adminPage.html';
import loginPageHtml from './loginPage.html';
import configPageHtml from './configPage.html';
import dashboardPageHtml from './dashboardPage.html';
import notifyLogsPageHtml from './notifyLogsPage.html';

// themeResources 需要注入到每個頁面範本中
function injectTheme(html) {
  return html.replace(/\$\{themeResources\}/g, themeResourcesHtml);
}

const loginPage = injectTheme(loginPageHtml);
const adminPage = injectTheme(adminPageHtml);
const configPage = injectTheme(configPageHtml);
const notifyLogsPage = injectTheme(notifyLogsPageHtml);

function dashboardPage() {
  return injectTheme(dashboardPageHtml);
}

export { loginPage, adminPage, configPage, dashboardPage, notifyLogsPage };
