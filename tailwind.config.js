// Builds public/css/site.css: `npm run build:css` after changing classes in the HTML files
module.exports = {
    // server.js builds the social links HTML
    content: ['./views/**/*.html', './public/**/*.html', './server.js'],
    theme: {
        extend: {
            colors: {
                brandDark: '#0B0F19',
                brandBlue: '#1E1B4B',
                brandPink: '#EC4899',
                brandYellow: '#F59E0B',
            },
        },
    },
    plugins: [],
};
