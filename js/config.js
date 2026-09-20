// 1. Create a free project at https://supabase.com
// 2. In Supabase: Project Settings > API. Copy the Project URL and the anon public key here.
// The anon key is safe to publish. The database rules in supabase/schema.sql are what protect the content.
window.APP_CONFIG = {
  SITE_NAME: "FP test Training",
  SUPABASE_URL: "https://kuusnruaokehqrfwjkbx.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_wmFIjTEziLzLQL0KLdpShw_CaWt_yQf",

    // Small links shown in the thin bar above the header (company site, support, etc).
  // Leave the list empty to hide the bar.
  UTILITY_LINKS: [
    { label: "Fluidra USA", url: "https://www.fluidrausa.com/en" },
    { label: "Jandy\u00AE", url: "https://www.jandy.com/en" },
    { label: "Polaris\u00AE", url: "https://www.polarispool.com/en" },
    { label: "Taylor\u00AE", url: "https://taylortechnologies.com/" }
  ],

  // Text on the sign-in landing page.
  HERO_TITLE: "Training designed with you in mind",
  HERO_TEXT: "Short video lessons in a set order, troubleshooting guides you can pull up on site, and a certificate when you finish a course.",

  // How many course cards to show per page.
  PAGE_SIZE: 4
};
