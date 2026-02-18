async function renderServiceCard(provider, serviceKey, sortOption = 'most-liked') {
    try {
        const template = `
<div class="card service-card p-6 rounded-2xl border-l-4 border-l-green-500 flex flex-col justify-between bg-white dark:bg-slate-800 shadow-sm" data-name="{{businessName}}" data-rating="{{ratingValue}}">
    <div>
        <div class="flex justify-between items-start mb-2">
            <div>
                <h3 class="text-xl font-bold">{{businessName}}</h3>
                <h4 class="text-md opacity-80">{{subHeading}}</h4>
            </div>
            <div class="flex items-center gap-1 text-sm font-bold text-amber-500 bg-amber-100 dark:bg-amber-900/50 px-2 py-1 rounded-full shrink-0">
                <span>{{rating}}</span>
                <i class="fas fa-star text-xs"></i>
            </div>
        </div>
        <p class="text-sm opacity-70 mb-4">{{description}}</p>
        
        <div class="{{servicesVisibility}} mb-4 bg-green-50/50 dark:bg-green-900/10 p-3 rounded-xl border border-green-100 dark:border-green-900/30">
            <p class="text-xs font-bold uppercase tracking-wider text-green-600 dark:text-green-400 mb-2 flex items-center gap-2">
                <i class="fas fa-tags text-[10px]"></i>
                Services & Pricing
            </p>
            <div class="grid grid-cols-1 gap-1">
                {{servicesList}}
            </div>
        </div>

        <div class="text-sm font-medium space-y-2 mb-4">
            <p class="flex items-center gap-2"><i class="fas fa-phone text-green-500"></i> <a href="tel:{{phone}}">{{phone}}</a></p>
            <p class="flex items-center gap-2 {{hoursVisibility}}"><i class="fas fa-clock text-green-500"></i> {{hours}}</p>
            <a href="{{mapsUrl}}" target="_blank" class="flex items-center gap-2"><i class="fas fa-map-marker-alt text-green-500"></i> {{address}}</a>
            <div class="{{galleryVisibility}} pt-2">
                <button class="view-gallery-btn text-xs font-bold text-green-600 dark:text-green-400 hover:underline flex items-center gap-1" data-photos='{{photosData}}'>
                    <i class="fas fa-images"></i> View Gallery
                </button>
            </div>
            <div class="flex gap-3 pt-2">
                {{socialLinks}}
            </div>
        </div>
    </div>

    <div class="flex flex-col sm:flex-row gap-2 mt-4 pt-4 border-t border-gray-100 dark:border-slate-700">
        <a href="tel:{{phone}}" class="flex-1 text-center py-2 bg-green-600 text-white rounded-lg font-bold hover:bg-green-700 transition">Call</a>
        <button class="flex-1 text-center py-2 bg-blue-600 text-white rounded-lg font-bold hover:bg-blue-700 transition rate-service" data-service-id="{{serviceId}}" data-service-key="{{serviceKey}}">Rate</button>
    </div>

    <div class="mt-4 pt-4 border-t border-gray-100 dark:border-slate-700">
        <div class="flex justify-between items-center mb-2">
            <p class="text-xs font-bold uppercase tracking-wider opacity-50">Recent Comments</p>
            <div class="flex items-center gap-2">
                <select class="comment-sort-select text-[10px] bg-transparent border-none opacity-50 hover:opacity-100 focus:ring-0 cursor-pointer outline-none p-0" data-service-id="{{serviceId}}" data-service-key="{{serviceKey}}">
                    <option value="most-liked">Most Liked</option>
                    <option value="least-liked">Least Liked</option>
                </select>
            </div>
        </div>
        <div class="comments-container space-y-2 max-h-48 overflow-hidden relative" data-service-id="{{serviceId}}">
            <div class="comments-wrapper space-y-2 pr-1 custom-scrollbar">
                {{comments}}
            </div>
            <div class="show-more-comments hidden absolute bottom-0 left-0 right-0 h-12 bg-gradient-to-t from-white dark:from-slate-800 to-transparent flex items-end justify-center pb-1 cursor-pointer transition-opacity hover:opacity-80">
                <i class="fas fa-chevron-down text-xs opacity-50"></i>
            </div>
        </div>
    </div>
</div>
`;

        const ratingValue = provider.rating || 0;
        const ratingDisplay = provider.rating ? parseFloat(provider.rating).toFixed(1) : 'N/A';
        const contact = provider.phone || provider.email || 'No contact';
        const address = provider.address || 'Poortjie';
        const latitude = provider.latitude;
        const longitude = provider.longitude;

        const mapsUrl = (latitude && longitude) 
            ? `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`
            : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address + (address.toLowerCase().includes('poortjie') ? '' : ', Poortjie'))}`;

        let hours = provider.hours || provider.operatingHours || provider.businessHours || 'N/A';
        const hoursVisibility = (provider.hours || provider.operatingHours || provider.businessHours) ? '' : 'hidden';

        // Format hours if it's the long daily format to be more compact on card if possible, 
        // but user asked to "show time selected on preview card", so we'll ensure it looks good.
        if (hours.includes(', ')) {
            const parts = hours.split(', ');
            if (parts.length === 7) {
                // Check if Mon-Fri are the same
                const monFriSame = parts.slice(0, 5).every(p => p.split(' ')[1] === parts[0].split(' ')[1]);
                if (monFriSame) {
                    const time = parts[0].split(' ')[1];
                    const sat = parts[5];
                    const sun = parts[6];
                    hours = `Mon-Fri ${time}, ${sat}, ${sun}`;
                }
            }
        }

        const services = provider.services || [];
        const servicesVisibility = services.length > 0 ? '' : 'hidden';
        const photos = provider.photos || [];
        const galleryVisibility = photos.length > 0 ? '' : 'hidden';
        const photosData = JSON.stringify(photos).replace(/'/g, "&#39;");

        const servicesListHtml = services.map(s => {
            let priceDisplay = s.price || '';
            if (priceDisplay && !priceDisplay.startsWith('R')) {
                priceDisplay = 'R' + priceDisplay;
            }
            return `
            <div class="flex justify-between items-center text-xs py-1.5 border-b border-green-100/50 dark:border-green-900/20 last:border-0">
                <span class="font-medium opacity-90">${s.name}</span>
                <span class="font-bold text-green-600 dark:text-green-400 bg-green-100 dark:bg-green-900/40 px-2 py-0.5 rounded-md">${priceDisplay}</span>
            </div>
        `;
        }).join('');

        // Process Ratings map into Comments HTML
        let commentsHtml;
        let hasMoreThanTwo = false;
        
        if (provider.ratings && Object.keys(provider.ratings).length > 0) {
            const currentUserId = firebase.auth().currentUser?.uid;

            const ratingEntries = Object.entries(provider.ratings)
                .map(([userId, r]) => ({ ...r, userId }))
                .filter(r => r.comment && r.comment.trim() !== '')
                .sort((a, b) => {
                    const likesA = a.likes ? Object.keys(a.likes).length : 0;
                    const likesB = b.likes ? Object.keys(b.likes).length : 0;
                    
                    if (sortOption === 'most-liked') {
                        if (likesB !== likesA) return likesB - likesA;
                    } else if (sortOption === 'least-liked') {
                        if (likesA !== likesB) return likesA - likesB;
                    }

                    const timeA = a.timestamp?.toMillis ? a.timestamp.toMillis() : 0;
                    const timeB = b.timestamp?.toMillis ? b.timestamp.toMillis() : 0;
                    return timeB - timeA;
                });

            if (ratingEntries.length > 0) {
                hasMoreThanTwo = ratingEntries.length > 2;
                // Initially show only 2 comments if more than 2 exist
                const displayedEntries = ratingEntries.slice(0, 5);
                
                commentsHtml = displayedEntries.map((r, index) => {
                    const likesCount = r.likes ? Object.keys(r.likes).length : 0;
                    const isLiked = currentUserId && r.likes && r.likes[currentUserId];
                    const likeIconClass = isLiked ? 'fas fa-heart text-red-500' : 'far fa-heart';
                    const hiddenClass = index >= 2 ? 'hidden extra-comment' : '';
                    
                    return `
                    <div class="p-3 bg-gray-50 dark:bg-slate-700/50 rounded-lg text-sm opacity-95 border-l-2 border-green-400 group relative ${hiddenClass}">
                        <div class="flex justify-between items-start mb-1">
                             <p class="italic">"${r.comment}"</p>
                             <button class="like-comment-btn flex items-center gap-1 text-xs transition-colors hover:text-red-500 ${isLiked ? 'text-red-500' : 'opacity-60'}" 
                                     data-comment-uid="${r.userId}" 
                                     data-service-id="${provider.id}" 
                                     data-service-key="${serviceKey}">
                                 <i class="${likeIconClass}"></i>
                                 <span class="likes-count">${likesCount}</span>
                             </button>
                        </div>
                    </div>
                `;}).join('');
            } else {
                commentsHtml = `<p class="text-xs opacity-50 italic">No comments yet.</p>`;
            }
        } else {
            commentsHtml = `<p class="text-xs opacity-50 italic">No comments yet.</p>`;
        }

        // Process Social Links
        let socialLinksHtml = '';
        const ensureHttps = (url) => {
            if (!url) return url;
            if (!/^https?:\/\//i.test(url)) {
                return `https://${url}`;
            }
            return url;
        };

        if (provider.whatsapp) {
            socialLinksHtml += `<a href="https://wa.me/27${provider.whatsapp.substring(1)}" target="_blank" class="text-green-500 hover:text-green-600 transition text-xl" title="WhatsApp"><i class="fab fa-whatsapp"></i></a>`;
        }
        if (provider.facebook) {
            let fbUrl = provider.facebook;
            if (!fbUrl.toLowerCase().includes('facebook.com')) {
                fbUrl = `facebook.com/${fbUrl.startsWith('/') ? fbUrl.substring(1) : fbUrl}`;
            }
            fbUrl = ensureHttps(fbUrl);
            socialLinksHtml += `<a href="${fbUrl}" target="_blank" class="text-blue-600 hover:text-blue-700 transition text-xl" title="Facebook"><i class="fab fa-facebook"></i></a>`;
        }
        if (provider.website) {
            const webUrl = ensureHttps(provider.website);
            socialLinksHtml += `<a href="${webUrl}" target="_blank" class="text-gray-500 hover:text-gray-600 dark:text-gray-400 dark:hover:text-white transition text-xl" title="Website"><i class="fas fa-globe"></i></a>`;
        }

        let cardHtml = template
            .replace(/{{businessName}}/g, provider.businessName)
            .replace(/{{subHeading}}/g, provider.subHeading)
            .replace(/{{ratingValue}}/g, ratingValue)
            .replace(/{{rating}}/g, ratingDisplay)
            .replace(/{{description}}/g, provider.description)
            .replace(/{{contact}}/g, contact)
            .replace(/{{address}}/g, address)
            .replace(/{{mapsUrl}}/g, mapsUrl)
            .replace(/{{phone}}/g, provider.phone)
            .replace(/{{hours}}/g, hours)
            .replace(/{{hoursVisibility}}/g, hoursVisibility)
            .replace(/{{galleryVisibility}}/g, galleryVisibility)
            .replace(/{{photosData}}/g, photosData)
            .replace(/{{servicesVisibility}}/g, servicesVisibility)
            .replace(/{{servicesList}}/g, servicesListHtml)
            .replace(/{{serviceId}}/g, provider.id)
            .replace(/{{serviceKey}}/g, serviceKey)
            .replace(/{{socialLinks}}/g, socialLinksHtml)
            .replace(/{{comments}}/g, commentsHtml);

        const cardElement = document.createElement('div');
        cardElement.innerHTML = cardHtml.trim();
        const firstChild = cardElement.firstChild;

        // Handle "Show More" visibility
        const showMoreBtn = firstChild.querySelector('.show-more-comments');
        if (showMoreBtn && hasMoreThanTwo) {
            showMoreBtn.classList.remove('hidden');
            showMoreBtn.addEventListener('click', () => {
                const extraComments = firstChild.querySelectorAll('.extra-comment');
                const isExpanded = showMoreBtn.querySelector('i').classList.contains('fa-chevron-up');
                
                extraComments.forEach(c => c.classList.toggle('hidden'));
                showMoreBtn.querySelector('i').className = isExpanded ? 'fas fa-chevron-down text-xs opacity-50' : 'fas fa-chevron-up text-xs opacity-50';
                
                if (!isExpanded) {
                    showMoreBtn.classList.remove('absolute', 'bottom-0', 'h-12', 'bg-gradient-to-t');
                    showMoreBtn.classList.add('mt-2');
                } else {
                    showMoreBtn.classList.add('absolute', 'bottom-0', 'h-12', 'bg-gradient-to-t');
                    showMoreBtn.classList.remove('mt-2');
                }
            });
        }

        // Handle Sort Change
        const sortSelect = firstChild.querySelector('.comment-sort-select');
        if (sortSelect) {
            sortSelect.value = sortOption;
            sortSelect.addEventListener('change', async (e) => {
                const newSort = e.target.value;
                const newCard = await renderServiceCard(provider, serviceKey, newSort);
                if (newCard) {
                    firstChild.replaceWith(newCard);
                }
            });
        }

        // Handle Gallery View
        const viewGalleryBtn = firstChild.querySelector('.view-gallery-btn');
        if (viewGalleryBtn) {
            viewGalleryBtn.addEventListener('click', () => {
                const photos = JSON.parse(viewGalleryBtn.dataset.photos);
                const modal = document.createElement('div');
                modal.className = 'fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/90 backdrop-blur-md animate-fadeIn';
                modal.innerHTML = `
                    <div class="relative w-full max-w-4xl max-h-[90vh] flex flex-col items-center">
                        <button class="absolute -top-12 right-0 text-white text-3xl hover:text-green-500 transition">
                            <i class="fas fa-times"></i>
                        </button>
                        <div class="w-full overflow-hidden rounded-2xl bg-black flex items-center justify-center">
                            <img src="${photos[0]}" class="max-w-full max-h-[70vh] object-contain" id="main-gallery-img">
                        </div>
                        <div class="flex gap-2 mt-4 overflow-x-auto p-2 max-w-full">
                            ${photos.map((p, i) => `
                                <img src="${p}" class="w-16 h-16 object-cover rounded-lg cursor-pointer border-2 ${i === 0 ? 'border-green-500' : 'border-transparent'} hover:border-green-500 transition gallery-thumb" data-index="${i}">
                            `).join('')}
                        </div>
                    </div>
                `;
                document.body.appendChild(modal);

                const mainImg = modal.querySelector('#main-gallery-img');
                const thumbs = modal.querySelectorAll('.gallery-thumb');
                const closeBtn = modal.querySelector('button');

                thumbs.forEach(thumb => {
                    thumb.addEventListener('click', () => {
                        mainImg.src = thumb.src;
                        thumbs.forEach(t => t.classList.remove('border-green-500'));
                        thumb.classList.add('border-green-500');
                    });
                });

                const closeModal = () => {
                    modal.classList.add('opacity-0');
                    setTimeout(() => modal.remove(), 200);
                };

                closeBtn.onclick = closeModal;
                modal.onclick = (e) => { if (e.target === modal) closeModal(); };
            });
        }

        return firstChild;

    } catch (error) {
        console.error("Error rendering service card:", error);
        return null;
    }
}