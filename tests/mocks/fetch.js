module.exports = function fetchFactory(fetchDataFn) {
    return function fetchMock(path) {
        return {
            json: () => {
                return fetchDataFn(path);
            },
        };
    };
}
