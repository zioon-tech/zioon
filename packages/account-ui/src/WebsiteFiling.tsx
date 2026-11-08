import "./website-filing.css";

const iconUrl = new URL("./public-security-filing.png", import.meta.url).href;

export function WebsiteFiling() {
  return <nav className="zioon-website-filing" aria-label="网站备案">
    <a href="https://beian.miit.gov.cn/" target="_blank" rel="noreferrer">
      赣ICP备2026025481号-1
    </a>
    <a href="https://beian.mps.gov.cn/#/query/webSearch?code=33011002020851"
      target="_blank" rel="noreferrer">
      <img src={iconUrl} width="18" height="20" alt="" aria-hidden="true" />
      浙公网安备33011002020851号
    </a>
  </nav>;
}
