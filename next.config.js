/**
 * @type {import('next').NextConfig}
 */
module.exports = {
  env: {
    commitTag: process.env.COMMIT_TAG || 'local',
  },
  images: {
    remotePatterns: [
      { hostname: 'gravatar.com' },
      { hostname: 'image.tmdb.org' },
      { hostname: 'artworks.thetvdb.com' },
      { hostname: 'plex.tv' },
    ],
  },
  webpack(config, { dev }) {
    config.module.rules.push({
      test: /\.svg$/,
      issuer: /\.(js|ts)x?$/,
      use: ['@svgr/webpack'],
    });

    // Avoid persistent webpack cache stalls on the seedbox filesystem.
    if (!dev && config.cache) {
      config.cache = false;
    }

    return config;
  },
  experimental: {
    cpus: 1,
    scrollRestoration: true,
    largePageDataBytes: 512 * 1000,
  },
};
