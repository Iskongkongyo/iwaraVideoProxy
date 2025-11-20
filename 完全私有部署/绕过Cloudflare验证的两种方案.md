# 绕过 Cloudflare 验证的两种方案

## 方案一：使用 `cloudscraper` 库（推荐）

这个库专门用于处理 Cloudflare 的反爬机制，可自动完成 JavaScript 验证挑战。

### 示例代码

```
import cloudscraper

# 创建 scraper 对象
scraper = cloudscraper.create_scraper(
    browser={
        'browser': 'firefox',
        'platform': 'windows',
        'mobile': False
    }
)

url = "https://目标网站.com"

try:
    # 发送请求（自动处理验证）
    response = scraper.get(url)
    
    # 检查响应状态
    if response.status_code == 200:
        print("成功绕过验证！")
        print(response.text[:500])  # 打印部分内容
    else:
        print("请求失败，状态码:", response.status_code)

except Exception as e:
    print("发生错误:", str(e))
```



### 安装依赖

```
pip install cloudscraper
```



------

## 方案二：Selenium 自动化浏览器

适用于需要交互操作的复杂验证（如点击验证按钮）。

### 示例代码

```
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
import time

options = webdriver.ChromeOptions()
# options.add_argument("--headless")  # 无头模式
driver = webdriver.Chrome(options=options)

url = "https://目标网站.com"

try:
    driver.get(url)
    
    # 等待 Cloudflare 验证完成（最长30秒）
    WebDriverWait(driver, 30).until(
        EC.presence_of_element_located((By.TAG_NAME, "body"))
    )
    
    print("页面标题:", driver.title)
    print("页面内容:", driver.page_source[:500])
    
except Exception as e:
    print("发生错误:", str(e))
finally:
    driver.quit()
```

## 方案三、使用 undetected-chromedriver信

这是全球通用做法，例如爬虫、反代、代理站点普遍用此方式绕 Cloudflare：

## ✔ 你只需要安装：

```
pip install undetected-chromedriver selenium
```

然后创建一个脚本：

### `cf_cookie.py`

```
import undetected_chromedriver as uc
import time
from selenium.webdriver.chrome.options import Options

def get_cookie(url):
    options = Options()
    options.add_argument("--disable-blink-features=AutomationControlled")
    options.add_argument("--no-sandbox")

    driver = uc.Chrome(options=options, headless=False)

    driver.get(url)
    print("等待 Cloudflare 验证…")

    time.sleep(12)

    cookies = driver.get_cookies()

    cookie_str = "; ".join([f"{c['name']}={c['value']}" for c in cookies])
    print(cookie_str)

    driver.quit()

if __name__ == "__main__":
    get_cookie("https://api.iwara.tv/video/xxxxx")
```

运行：

```
python cf_cookie.py
```

你一定能得到 `cf_clearance`。

------