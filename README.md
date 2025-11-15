# 简单反代Iwara(I站)视频

## 项目内容：

index.html是反代Iwara的前端页面，使用前端三件套（HTML+CSS+JS）简单编写。

worker.js是项目的入口js文件，其中包含index.html内容和反代I站视频的内容。

## 部署方法：

方法一（强烈建议）：使用邮箱注册Cloudflare账号，然后新建一个Worker项目。最后将worker.js文件内容拷贝粘贴到新创建的Worker项目后保存即可使用！

> [!CAUTION]
>
> 注意：强烈建议添加自定义域。因为部署好的worker项目默认提供的域名在大陆被DNS污染，无法直接访问。所以强烈建议您添加一个托管在Cloudflare网站上面的域名！！！

方法二：如果您想将该服务部署到自己的服务器（非中国大陆地区），服务器部署我的简单反代项目[simpleProxy](https://github.com/Iskongkongyo/simpleProxy)。将index.html中资源请求的链接替换成你部署的反代项目的访问域名。将我的简单反向项目index.js文件中的“res.setHeader('Access-Control-Allow-Headers','');”替换成"res.setHeader('Access-Control-Allow-Headers','x-version');"。index2.html配合我的简单反代项目即可实现完全本地化部署。

> [!CAUTION]
>
> 注意：最好将我的简单反向项目index.js文件中的“res.setHeader('Access-Control-Allow-Origin','*');”替换成
>
> "res.setHeader('Access-Control-Allow-Origin','index2.html文件的访问源');"。这样可以访问部署的反代API接口被滥用！！！

方法三（有学习门槛）：如果您想将该服务部署到自己的服务器（非中国大陆地区），那么您需要在服务器端使用Nginx/Apache/Caddy等Web服务器实现类似worker.js里面对Iwara的反向代理。将index.html里面跟反代Iwara相关的接口替换成你实现的接口。然后为index.html创建虚拟主机提供Web访问服务。

> [!CAUTION]
>
> 注意：解决index.html访问您部署反代接口可能出现的CORS问题！！！

## 示例网站：

https://ss.iys.pp.ua

https://ss.ixq.pp.ua

![网站页面](https://files.catbox.moe/3on5gp.png)

## 鸣谢：

[Iwara](https://www.iwara.tv)

[Cloudflare](https://www.cloudflare.com/)

[SweetAlert](https://sweetalert.js.org/)

